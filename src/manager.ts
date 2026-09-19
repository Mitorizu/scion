import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import {
	CONFIG_DIR_NAME,
	formatSkillsForPrompt,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import safeRegex from "safe-regex2";
import {
	buildSkillDependencyGraph,
	parseSkillMetadata,
} from "./indexer.js";
import {
	DEFAULT_MAX_ACTIVE_SKILLS,
	type DomainTriggerSpec,
	type ParsedSkillMetadata,
	type ScionConfig,
	type SkillDependencyGraph,
	type SkillGraphDiagnostic,
	type SkillMetadataResult,
} from "./types.js";

const CACHE_VERSION = 2;
const DIAGNOSTIC_CODES = new Set([
	"frontmatter-read",
	"metadata-shape",
	"missing-dependency",
	"dependency-disabled",
	"dependency-cycle",
	"dependency-budget",
]);

interface SkillFileSnapshot {
	name: string;
	filePath: string;
	description: string;
	mtimeMs: number;
	size: number;
}

interface CachedMetadataEntry extends SkillFileSnapshot {
	metadata?: ParsedSkillMetadata;
	diagnostics: readonly SkillGraphDiagnostic[];
}

interface SkillGraphCache {
	version: number;
	entries: CachedMetadataEntry[];
}

export interface GraphLoadResult {
	graph: SkillDependencyGraph;
	durationMs: number;
	fromCache: boolean;
}

export interface PromptMaskResult {
	systemPrompt: string;
	masked: boolean;
}

export interface ScionManagerOptions {
	cacheRoot?: string;
	maxActiveSkills?: number;
	now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeTrigger(value: unknown): DomainTriggerSpec | undefined {
	if (!isRecord(value)) return undefined;
	if (value.kind === "regex" && typeof value.pattern === "string") {
		try {
			new RegExp(value.pattern, "u");
			if (value.pattern.length > 256 || !safeRegex(value.pattern)) return undefined;
			return { kind: "regex", pattern: value.pattern };
		} catch {
			return undefined;
		}
	}
	if (value.kind === "literal" && typeof value.value === "string") {
		return { kind: "literal", value: value.value };
	}
	return undefined;
}

function decodeMetadata(value: unknown): ParsedSkillMetadata | undefined {
	if (!isRecord(value)
		|| !Array.isArray(value.dependsOn)
		|| !Array.isArray(value.domainTriggers)
		|| !Array.isArray(value.toolNames)) return undefined;
	if (value.dependsOn.some((entry) => typeof entry !== "string")
		|| value.toolNames.some((entry) => typeof entry !== "string")) return undefined;
	const triggers = value.domainTriggers.map(decodeTrigger);
	if (triggers.some((entry) => entry === undefined)) return undefined;
	return {
		dependsOn: value.dependsOn as string[],
		domainTriggers: triggers as DomainTriggerSpec[],
		toolNames: value.toolNames as string[],
	};
}

function decodeDiagnostics(value: unknown): SkillGraphDiagnostic[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const diagnostics: SkillGraphDiagnostic[] = [];
	for (const entry of value) {
		if (!isRecord(entry)
			|| typeof entry.code !== "string"
			|| !DIAGNOSTIC_CODES.has(entry.code)
			|| typeof entry.skill !== "string"
			|| typeof entry.message !== "string") {
			return undefined;
		}
		diagnostics.push(entry as unknown as SkillGraphDiagnostic);
	}
	return diagnostics;
}

function decodeCache(value: unknown): SkillGraphCache | undefined {
	if (!isRecord(value) || value.version !== CACHE_VERSION || !Array.isArray(value.entries)) return undefined;
	const entries: CachedMetadataEntry[] = [];
	for (const rawEntry of value.entries) {
		if (!isRecord(rawEntry)
			|| typeof rawEntry.name !== "string"
			|| typeof rawEntry.filePath !== "string"
			|| typeof rawEntry.description !== "string"
			|| typeof rawEntry.mtimeMs !== "number"
			|| typeof rawEntry.size !== "number") return undefined;
		const diagnostics = decodeDiagnostics(rawEntry.diagnostics);
		if (!diagnostics) return undefined;
		const metadata = rawEntry.metadata === undefined ? undefined : decodeMetadata(rawEntry.metadata);
		if (rawEntry.metadata !== undefined && !metadata) return undefined;
		entries.push({
			name: rawEntry.name,
			filePath: rawEntry.filePath,
			description: rawEntry.description,
			mtimeMs: rawEntry.mtimeMs,
			size: rawEntry.size,
			...(metadata ? { metadata } : {}),
			diagnostics,
		});
	}
	return { version: CACHE_VERSION, entries };
}

function snapshots(skills: readonly Skill[]): SkillFileSnapshot[] {
	return skills.map((skill) => {
		try {
			const stats = statSync(skill.filePath);
			return {
				name: skill.name,
				filePath: skill.filePath,
				description: skill.description,
				mtimeMs: stats.mtimeMs,
				size: stats.size,
			};
		} catch {
			return {
				name: skill.name,
				filePath: skill.filePath,
				description: skill.description,
				mtimeMs: 0,
				size: 0,
			};
		}
	});
}

function sameSnapshots(left: readonly SkillFileSnapshot[], right: readonly SkillFileSnapshot[]): boolean {
	if (left.length !== right.length) return false;
	return left.every((entry, index) => {
		const other = right[index];
		return other !== undefined
			&& entry.name === other.name
			&& entry.filePath === other.filePath
			&& entry.description === other.description
			&& entry.mtimeMs === other.mtimeMs
			&& entry.size === other.size;
	});
}

function configPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "scion.json");
}

export function loadScionConfig(cwd: string, projectTrusted: boolean): ScionConfig {
	if (!projectTrusted) return { mode: "observe" };
	try {
		const value = JSON.parse(readFileSync(configPath(cwd), "utf8")) as unknown;
		if (isRecord(value) && value.mode === "mask") return { mode: "mask" };
	} catch {
		// Missing or invalid project configuration keeps the safe observe default.
	}
	return { mode: "observe" };
}

export function maskSkillCatalog(
	systemPrompt: string,
	allSkills: readonly Skill[],
	selectedNames: readonly string[],
	fileReadTool: "read" | "bash",
): PromptMaskResult {
	const currentCatalog = formatSkillsForPrompt([...allSkills], fileReadTool);
	if (!currentCatalog || !systemPrompt.includes(currentCatalog)) return { systemPrompt, masked: false };
	const selected = new Set(selectedNames);
	const nextCatalog = formatSkillsForPrompt(allSkills.filter((skill) => selected.has(skill.name)), fileReadTool);
	return {
		systemPrompt: systemPrompt.replace(currentCatalog, nextCatalog),
		masked: true,
	};
}

export class ScionManager {
	private readonly cacheRoot: string;
	private readonly maxActiveSkills: number;
	private readonly now: () => number;
	private graphKey: string | undefined;
	private graph: SkillDependencyGraph | undefined;

	constructor(options: ScionManagerOptions = {}) {
		this.cacheRoot = options.cacheRoot ?? join(homedir(), ".cache", "scion");
		this.maxActiveSkills = options.maxActiveSkills ?? DEFAULT_MAX_ACTIVE_SKILLS;
		this.now = options.now ?? performance.now.bind(performance);
	}

	private cachePath(cwd: string): string {
		const key = createHash("sha256").update(cwd).digest("hex").slice(0, 24);
		return join(this.cacheRoot, key, "index.json");
	}

	private readCache(path: string, current: readonly SkillFileSnapshot[]): SkillGraphCache | undefined {
		try {
			const decoded = decodeCache(JSON.parse(readFileSync(path, "utf8")));
			return decoded && sameSnapshots(decoded.entries, current) ? decoded : undefined;
		} catch {
			return undefined;
		}
	}

	private writeCache(path: string, cache: SkillGraphCache): void {
		const directory = dirname(path);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		chmodSync(directory, 0o700);
		const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
		try {
			writeFileSync(temporary, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
			renameSync(temporary, path);
			chmodSync(path, 0o600);
		} catch (error) {
			rmSync(temporary, { force: true });
			throw error;
		}
	}

	loadGraph(cwd: string, skills: readonly Skill[]): GraphLoadResult {
		const startedAt = this.now();
		const current = snapshots(skills);
		const graphKey = JSON.stringify(current);
		if (this.graph && this.graphKey === graphKey) {
			return { graph: this.graph, durationMs: this.now() - startedAt, fromCache: true };
		}
		const path = this.cachePath(cwd);
		const cached = this.readCache(path, current);
		const metadata = new Map<string, SkillMetadataResult>();
		if (cached) {
			for (const entry of cached.entries) {
				metadata.set(entry.name, {
					...(entry.metadata ? { metadata: entry.metadata } : {}),
					diagnostics: entry.diagnostics,
				});
			}
		} else {
			for (const skill of skills) metadata.set(skill.name, parseSkillMetadata(skill));
			const entries: CachedMetadataEntry[] = current.map((snapshot) => {
				const result = metadata.get(snapshot.name) ?? { diagnostics: [] };
				return {
					...snapshot,
					...(result.metadata ? { metadata: result.metadata } : {}),
					diagnostics: result.diagnostics,
				};
			});
			try {
				this.writeCache(path, { version: CACHE_VERSION, entries });
			} catch {
				// The in-memory graph remains usable when the cache cannot be written.
			}
		}
		this.graph = buildSkillDependencyGraph(skills, metadata, this.maxActiveSkills);
		this.graphKey = graphKey;
		return { graph: this.graph, durationMs: this.now() - startedAt, fromCache: cached !== undefined };
	}

	invalidate(cwd: string): void {
		this.graph = undefined;
		this.graphKey = undefined;
		if (existsSync(this.cachePath(cwd))) rmSync(this.cachePath(cwd), { force: true });
	}
}
