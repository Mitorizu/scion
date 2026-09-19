import { readFileSync } from "node:fs";
import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import safeRegex from "safe-regex2";
import { parse } from "yaml";
import {
	DEFAULT_MAX_ACTIVE_SKILLS,
	type DisabledSkillNode,
	type DomainTriggerSpec,
	type ParsedSkillMetadata,
	type SkillDependencyGraph,
	type SkillEdge,
	type SkillGraphDiagnostic,
	type SkillMetadataResult,
	type SkillNode,
} from "./types.js";

function frontmatterText(content: string): string | undefined {
	const normalized = content.replace(/^\uFEFF/u, "");
	const lines = normalized.split(/\r?\n/u);
	if (lines[0]?.trim() !== "---") return undefined;
	for (let index = 1; index < lines.length; index += 1) {
		if (lines[index]?.trim() === "---" || lines[index]?.trim() === "...") {
			return lines.slice(1, index).join("\n");
		}
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function metadataDiagnostic(skill: Skill, message: string): SkillGraphDiagnostic {
	return { code: "metadata-shape", skill: skill.name, message };
}

function parseDependsOn(skill: Skill, value: unknown, diagnostics: SkillGraphDiagnostic[]): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
		diagnostics.push(metadataDiagnostic(skill, "metadata.depends_on must be an array of non-empty skill names."));
		return [];
	}
	return [...new Set(value.map((entry) => (entry as string).trim()))];
}

function parseAllowedTools(skill: Skill, value: unknown, diagnostics: SkillGraphDiagnostic[]): string[] {
	if (value === undefined) return [];
	if (typeof value !== "string" || value.trim() === "") {
		diagnostics.push(metadataDiagnostic(skill, "allowed-tools must be a space-delimited list of tool names."));
		return [];
	}
	return [...new Set(value.trim().split(/\s+/u))];
}

function addRegexTrigger(
	skill: Skill,
	pattern: string,
	triggers: DomainTriggerSpec[],
	diagnostics: SkillGraphDiagnostic[],
): void {
	try {
		new RegExp(pattern, "u");
		if (pattern.length > 256 || !safeRegex(pattern)) {
			diagnostics.push(metadataDiagnostic(skill, `Unsafe domain trigger regex: ${pattern}`));
			return;
		}
		triggers.push({ kind: "regex", pattern });
	} catch {
		diagnostics.push(metadataDiagnostic(skill, `Invalid domain trigger regex: ${pattern}`));
	}
}

function parseDomainTriggers(skill: Skill, value: unknown, diagnostics: SkillGraphDiagnostic[]): DomainTriggerSpec[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		diagnostics.push(metadataDiagnostic(skill, "metadata.domain_trigger must be an array."));
		return [];
	}
	const triggers: DomainTriggerSpec[] = [];
	for (const entry of value) {
		if (typeof entry === "string") {
			addRegexTrigger(skill, entry, triggers, diagnostics);
			continue;
		}
		if (!isRecord(entry)) {
			diagnostics.push(metadataDiagnostic(skill, "Each domain trigger must be a regex string or an object with regex or match."));
			continue;
		}
		const regex = entry.regex;
		const match = entry.match;
		if (typeof regex === "string" && match === undefined) {
			addRegexTrigger(skill, regex, triggers, diagnostics);
			continue;
		}
		if (typeof match === "string" && match.trim() !== "" && regex === undefined) {
			triggers.push({ kind: "literal", value: match });
			continue;
		}
		diagnostics.push(metadataDiagnostic(skill, "A domain trigger object must contain exactly one non-empty regex or match field."));
	}
	return triggers;
}

export function parseSkillMetadata(skill: Skill): SkillMetadataResult {
	const diagnostics: SkillGraphDiagnostic[] = [];
	let content: string;
	try {
		content = readFileSync(skill.filePath, "utf8");
	} catch (error) {
		const detail = error instanceof Error ? error.message : "could not read the skill file";
		return {
			diagnostics: [{ code: "frontmatter-read", skill: skill.name, message: detail }],
		};
	}
	const frontmatter = frontmatterText(content);
	if (frontmatter === undefined) {
		return {
			diagnostics: [{ code: "frontmatter-read", skill: skill.name, message: "Skill frontmatter is missing or unterminated." }],
		};
	}
	let document: unknown;
	try {
		document = parse(frontmatter);
	} catch (error) {
		const detail = error instanceof Error ? error.message : "could not parse YAML frontmatter";
		return {
			diagnostics: [{ code: "frontmatter-read", skill: skill.name, message: detail }],
		};
	}
	if (!isRecord(document)) {
		return {
			diagnostics: [metadataDiagnostic(skill, "Skill frontmatter must be a YAML mapping.")],
		};
	}
	const toolNames = parseAllowedTools(skill, document["allowed-tools"], diagnostics);
	const rawMetadata = document.metadata;
	if (rawMetadata === undefined) {
		return diagnostics.length > 0
			? { diagnostics }
			: { metadata: { dependsOn: [], domainTriggers: [], toolNames }, diagnostics };
	}
	if (!isRecord(rawMetadata)) {
		return {
			diagnostics: [metadataDiagnostic(skill, "metadata must be a YAML mapping.")],
		};
	}
	const dependsOn = parseDependsOn(skill, rawMetadata.depends_on, diagnostics);
	const domainTriggers = parseDomainTriggers(skill, rawMetadata.domain_trigger, diagnostics);
	return diagnostics.length > 0
		? { diagnostics }
		: { metadata: { dependsOn, domainTriggers, toolNames }, diagnostics };
}

function nodeFrom(skill: Skill, metadata: ParsedSkillMetadata): SkillNode {
	return {
		name: skill.name,
		description: skill.description,
		filePath: skill.filePath,
		dependsOn: metadata.dependsOn,
		domainTriggers: metadata.domainTriggers,
		toolNames: metadata.toolNames,
		skill,
	};
}

function addDisabledReason(disabled: Map<string, string[]>, name: string, reason: string): boolean {
	const reasons = disabled.get(name) ?? [];
	if (reasons.includes(reason)) return false;
	disabled.set(name, [...reasons, reason]);
	return true;
}

function propagateDisabledDependencies(
	nodes: ReadonlyMap<string, SkillNode>,
	disabled: Map<string, string[]>,
	diagnostics: SkillGraphDiagnostic[],
): void {
	let changed = true;
	while (changed) {
		changed = false;
		for (const node of nodes.values()) {
			if (disabled.has(node.name)) continue;
			for (const dependency of node.dependsOn) {
				if (!disabled.has(dependency)) continue;
				const message = `Dependency ${dependency} is disabled.`;
				if (addDisabledReason(disabled, node.name, message)) {
					diagnostics.push({ code: "dependency-disabled", skill: node.name, message });
					changed = true;
				}
			}
		}
	}
}

function findCycles(nodes: ReadonlyMap<string, SkillNode>, disabled: ReadonlyMap<string, readonly string[]>): string[][] {
	const state = new Map<string, "visiting" | "visited">();
	const stack: string[] = [];
	const cycles: string[][] = [];
	const seen = new Set<string>();
	const visit = (name: string): void => {
		if (disabled.has(name) || state.get(name) === "visited") return;
		if (state.get(name) === "visiting") {
			const start = stack.indexOf(name);
			const cycle = [...stack.slice(start), name];
			const key = [...new Set(cycle)].sort().join("\0");
			if (!seen.has(key)) {
				seen.add(key);
				cycles.push(cycle);
			}
			return;
		}
		state.set(name, "visiting");
		stack.push(name);
		for (const dependency of nodes.get(name)?.dependsOn ?? []) visit(dependency);
		stack.pop();
		state.set(name, "visited");
	};
	for (const name of nodes.keys()) visit(name);
	return cycles;
}

function dependencyClosure(name: string, nodes: ReadonlyMap<string, SkillNode>, disabled: ReadonlyMap<string, readonly string[]>): string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	const visit = (current: string): void => {
		if (seen.has(current) || disabled.has(current) || !nodes.has(current)) return;
		seen.add(current);
		result.push(current);
		for (const dependency of nodes.get(current)?.dependsOn ?? []) visit(dependency);
	};
	visit(name);
	return result;
}

export function buildSkillDependencyGraph(
	skills: readonly Skill[],
	metadataByName: ReadonlyMap<string, SkillMetadataResult>,
	maxActiveSkills = DEFAULT_MAX_ACTIVE_SKILLS,
): SkillDependencyGraph {
	const nodes = new Map<string, SkillNode>();
	const disabled = new Map<string, string[]>();
	const diagnostics: SkillGraphDiagnostic[] = [];
	for (const skill of skills) {
		const result = metadataByName.get(skill.name) ?? { diagnostics: [] };
		diagnostics.push(...result.diagnostics);
		const metadata = result.metadata;
		if (!metadata) {
			addDisabledReason(disabled, skill.name, "Skill metadata is invalid.");
			nodes.set(skill.name, nodeFrom(skill, { dependsOn: [], domainTriggers: [], toolNames: [] }));
			continue;
		}
		nodes.set(skill.name, nodeFrom(skill, metadata));
	}
	for (const node of nodes.values()) {
		for (const dependency of node.dependsOn) {
			if (!nodes.has(dependency)) {
				const message = `Dependency ${dependency} does not exist.`;
				addDisabledReason(disabled, node.name, message);
				diagnostics.push({ code: "missing-dependency", skill: node.name, message });
			}
		}
	}
	for (const cycle of findCycles(nodes, disabled)) {
		const message = `Dependency cycle: ${cycle.join(" -> ")}`;
		for (const name of new Set(cycle)) {
			addDisabledReason(disabled, name, message);
			diagnostics.push({ code: "dependency-cycle", skill: name, message });
		}
	}
	propagateDisabledDependencies(nodes, disabled, diagnostics);
	for (const node of nodes.values()) {
		if (disabled.has(node.name)) continue;
		const closure = dependencyClosure(node.name, nodes, disabled);
		if (closure.length > maxActiveSkills) {
			const message = `Dependency closure has ${closure.length} skills, exceeding the limit of ${maxActiveSkills}: ${closure.join(", ")}`;
			addDisabledReason(disabled, node.name, message);
			diagnostics.push({ code: "dependency-budget", skill: node.name, message });
		}
	}
	propagateDisabledDependencies(nodes, disabled, diagnostics);

	const activeNodes = new Map<string, SkillNode>();
	const disabledNodes = new Map<string, DisabledSkillNode>();
	for (const node of nodes.values()) {
		const reasons = disabled.get(node.name);
		if (reasons) disabledNodes.set(node.name, { ...node, reasons });
		else activeNodes.set(node.name, node);
	}
	const edges: SkillEdge[] = [];
	for (const node of activeNodes.values()) {
		for (const dependency of node.dependsOn) {
			if (activeNodes.has(dependency)) edges.push({ from: node.name, to: dependency });
		}
	}
	const closures = new Map<string, readonly string[]>();
	for (const name of activeNodes.keys()) closures.set(name, dependencyClosure(name, activeNodes, new Map()));
	return { nodes: activeNodes, disabledNodes, edges, closures, diagnostics };
}

export function indexSkills(
	skills: readonly Skill[],
	maxActiveSkills = DEFAULT_MAX_ACTIVE_SKILLS,
): SkillDependencyGraph {
	const metadata = new Map<string, SkillMetadataResult>();
	for (const skill of skills) metadata.set(skill.name, parseSkillMetadata(skill));
	return buildSkillDependencyGraph(skills, metadata, maxActiveSkills);
}

export function indexSkillDirectory(
	directory: string,
	maxActiveSkills = DEFAULT_MAX_ACTIVE_SKILLS,
): SkillDependencyGraph {
	const loaded = loadSkillsFromDir({ dir: directory, source: "scion" });
	return indexSkills(loaded.skills, maxActiveSkills);
}
