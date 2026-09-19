import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	formatSkillsForPrompt,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionContext,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import scion, { initializeScion, parseGitStatusPaths } from "../src/index.js";
import { buildSkillDependencyGraph, indexSkillDirectory, indexSkills, parseSkillMetadata } from "../src/indexer.js";
import { loadScionConfig, maskSkillCatalog, ScionManager } from "../src/manager.js";
import { resolveLinkedTools, routeSkills } from "../src/router.js";
import type { SkillDependencyGraph, SkillMetadataResult, SkillNode } from "../src/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

async function createSkill(root: string, name: string, description: string, metadata = ""): Promise<Skill> {
	const filePath = join(root, name, "SKILL.md");
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, `---\nname: ${name}\ndescription: ${description}\n${metadata}---\n\n# ${name}\n`);
	return {
		name,
		description,
		filePath,
		baseDir: dirname(filePath),
		disableModelInvocation: false,
		sourceInfo: { path: filePath, source: "test", scope: "project", origin: "top-level" },
	};
}

describe("skill graph indexing", () => {
	it("parses dependencies, regex triggers, and literal triggers", async () => {
		const root = await temporaryDirectory("scion-skills-");
		const base = await createSkill(root, "systems-review", "Review systems code.");
		const rust = await createSkill(root, "rust-review", "Review Rust code.", `allowed-tools: rust_analyzer\nmetadata:\n  depends_on:\n    - systems-review\n  domain_trigger:\n    - '\\.rs$'\n    - match: Cargo.toml\n`);
		expect(parseSkillMetadata(rust).metadata).toEqual({
			dependsOn: ["systems-review"],
			domainTriggers: [
				{ kind: "regex", pattern: "\\.rs$" },
				{ kind: "literal", value: "Cargo.toml" },
			],
			toolNames: ["rust_analyzer"],
		});
		const graph = indexSkills([base, rust]);
		expect(graph.edges).toEqual([{ from: "rust-review", to: "systems-review" }]);
		expect(graph.closures.get("rust-review")).toEqual(["rust-review", "systems-review"]);
		expect(indexSkillDirectory(root).nodes.has("rust-review")).toBe(true);
	});

	it("rejects malformed allowed-tools fields", async () => {
		const root = await temporaryDirectory("scion-skills-");
		const skill = await createSkill(root, "bad-tools", "Bad tool metadata.", "allowed-tools: [read]\n");
		const result = parseSkillMetadata(skill);
		expect(result.metadata).toBeUndefined();
		expect(result.diagnostics[0]?.message).toContain("space-delimited list");
	});

	it("rejects unsafe domain trigger regexes", async () => {
		const root = await temporaryDirectory("scion-skills-");
		const skill = await createSkill(root, "unsafe-regex", "Unsafe regex.", "metadata:\n  domain_trigger: ['(a+)+$']\n");
		const graph = indexSkills([skill]);
		expect(graph.disabledNodes.has("unsafe-regex")).toBe(true);
		expect(graph.diagnostics[0]?.message).toContain("Unsafe domain trigger regex");
	});

	it("disables missing dependencies, cycles, and closures over budget", async () => {
		const root = await temporaryDirectory("scion-skills-");
		const missing = await createSkill(root, "missing-user", "Needs an absent skill.", "metadata:\n  depends_on: [absent]\n");
		const cycleA = await createSkill(root, "cycle-a", "Cycle A.", "metadata:\n  depends_on: [cycle-b]\n");
		const cycleB = await createSkill(root, "cycle-b", "Cycle B.", "metadata:\n  depends_on: [cycle-a]\n");
		const chain: Skill[] = [];
		for (let index = 1; index <= 6; index += 1) {
			chain.push(await createSkill(
				root,
				`chain-${index}`,
				`Chain ${index}.`,
				index < 6 ? `metadata:\n  depends_on: [chain-${index + 1}]\n` : "",
			));
		}
		const graph = indexSkills([missing, cycleA, cycleB, ...chain]);
		expect(graph.disabledNodes.has("missing-user")).toBe(true);
		expect(graph.disabledNodes.has("cycle-a")).toBe(true);
		expect(graph.disabledNodes.has("cycle-b")).toBe(true);
		expect(graph.disabledNodes.has("chain-1")).toBe(true);
		expect(graph.diagnostics.map((entry) => entry.code)).toEqual(expect.arrayContaining([
			"missing-dependency",
			"dependency-cycle",
			"dependency-budget",
		]));
	});
});

describe("skill routing", () => {
	it("ranks domain matches and includes dependencies", async () => {
		const root = await temporaryDirectory("scion-skills-");
		const base = await createSkill(root, "systems-review", "Review architecture boundaries.");
		const rust = await createSkill(root, "rust-review", "Review Rust ownership and lifetimes.", "metadata:\n  depends_on: [systems-review]\n  domain_trigger: ['\\.rs$']\n");
		const docs = await createSkill(root, "documentation", "Write user documentation.", "metadata:\n  domain_trigger:\n    - match: README.md\n");
		const graph = indexSkills([base, rust, docs]);
		const result = routeSkills(graph, {
			prompt: "Review the ownership changes",
			changedPaths: ["src/lib.rs"],
		});
		expect(result.selectedNames).toEqual(["rust-review", "systems-review"]);
		expect(result.matches[0]?.reasons.some((reason) => reason.kind === "domain-trigger")).toBe(true);
		expect(result.matches[1]?.reasons.some((reason) => reason.kind === "dependency")).toBe(true);
	});

	it("resolves linked tools from selected skills and their dependencies", async () => {
		const root = await temporaryDirectory("scion-skills-");
		const base = await createSkill(root, "systems-review", "Review architecture.", "allowed-tools: read\n");
		const rust = await createSkill(root, "rust-review", "Review Rust ownership.", "allowed-tools: rust_analyzer missing_tool\nmetadata:\n  depends_on: [systems-review]\n");
		const graph = indexSkills([base, rust]);

		expect(resolveLinkedTools(graph, ["rust-review", "systems-review"], ["read", "rust_analyzer"])).toEqual({
			linkedToolNames: ["rust_analyzer", "read"],
			unavailableToolNames: ["missing_tool"],
		});
	});

	it("routes a manual skill only when it was explicitly invoked", async () => {
		const root = await temporaryDirectory("scion-skills-");
		const manual = await createSkill(root, "release", "Publish a release.", "allowed-tools: publish_release\n");
		manual.disableModelInvocation = true;
		const graph = indexSkills([manual]);

		expect(routeSkills(graph, { prompt: "Publish a release", changedPaths: [] }).selectedNames).toEqual([]);
		expect(routeSkills(graph, {
			prompt: '<skill name="release" location="/tmp/release/SKILL.md">\nRelease instructions\n</skill>',
			changedPaths: [],
			explicitSkillName: "release",
		}).selectedNames).toEqual(["release"]);
	});

	it("returns no skills when the context has no match", async () => {
		const root = await temporaryDirectory("scion-skills-");
		const rust = await createSkill(root, "rust-review", "Review Rust ownership.", "metadata:\n  domain_trigger: ['\\.rs$']\n");
		const result = routeSkills(indexSkills([rust]), { prompt: "Say hello", changedPaths: [] });
		expect(result.selectedNames).toEqual([]);
	});

	it("routes 500 skills in less than 50 milliseconds", () => {
		const nodes = new Map<string, SkillNode>();
		const closures = new Map<string, readonly string[]>();
		for (let index = 0; index < 500; index += 1) {
			const name = `skill-${index}`;
			const skill = {
				name,
				description: `Handle domain${index} workflows.`,
				filePath: `/tmp/${name}/SKILL.md`,
				baseDir: `/tmp/${name}`,
				disableModelInvocation: false,
				sourceInfo: { path: `/tmp/${name}/SKILL.md`, source: "test", scope: "project", origin: "top-level" },
			} satisfies Skill;
			nodes.set(name, { name, description: skill.description, filePath: skill.filePath, dependsOn: [], domainTriggers: [], toolNames: [], skill });
			closures.set(name, [name]);
		}
		const graph: SkillDependencyGraph = {
			nodes,
			disabledNodes: new Map(),
			edges: [],
			closures,
			diagnostics: [],
		};
		const result = routeSkills(graph, { prompt: "Handle domain499 workflows", changedPaths: [] });
		expect(result.selectedNames).toContain("skill-499");
		expect(result.durationMs).toBeLessThan(50);
	});
});

describe("Scion manager", () => {
	it("loads cached metadata without reading a different graph shape", async () => {
		const root = await temporaryDirectory("scion-skills-");
		const cacheRoot = await temporaryDirectory("scion-skill-cache-");
		const skill = await createSkill(root, "rust-review", "Review Rust.", "allowed-tools: rust_analyzer\nmetadata:\n  domain_trigger: ['\\.rs$']\n");
		const first = new ScionManager({ cacheRoot }).loadGraph(root, [skill]);
		const second = new ScionManager({ cacheRoot }).loadGraph(root, [skill]);
		expect(first.fromCache).toBe(false);
		expect(second.fromCache).toBe(true);
		expect(second.graph.nodes.get("rust-review")?.domainTriggers).toEqual(first.graph.nodes.get("rust-review")?.domainTriggers);
		expect(second.graph.nodes.get("rust-review")?.toolNames).toEqual(["rust_analyzer"]);
		const [cacheDirectory] = await readdir(cacheRoot);
		expect(cacheDirectory).toBeDefined();
		expect((await stat(join(cacheRoot, cacheDirectory!, "index.json"))).mode & 0o777).toBe(0o600);
	});

	it("masks only Pi's generated skill catalog", async () => {
		const root = await temporaryDirectory("scion-skills-");
		const rust = await createSkill(root, "rust-review", "Review Rust.");
		const docs = await createSkill(root, "documentation", "Write documentation.");
		const catalog = formatSkillsForPrompt([rust, docs], "read");
		const prompt = `System header${catalog}\nCurrent working directory: ${root}`;
		const result = maskSkillCatalog(prompt, [rust, docs], ["rust-review"], "read");
		expect(result.masked).toBe(true);
		expect(result.systemPrompt).toContain("rust-review");
		expect(result.systemPrompt).not.toContain("documentation");
		expect(result.systemPrompt).toContain("System header");
	});

	it("enables masking only for a trusted project configuration", async () => {
		const root = await temporaryDirectory("scion-project-");
		await mkdir(join(root, ".pi"), { recursive: true });
		await writeFile(join(root, ".pi", "scion.json"), '{"mode":"mask"}\n');
		expect(loadScionConfig(root, true)).toEqual({ mode: "mask" });
		expect(loadScionConfig(root, false)).toEqual({ mode: "observe" });
	});
});

describe("Scion extension", () => {
	it("parses staged, modified, deleted, untracked, and renamed Git paths", () => {
		expect(parseGitStatusPaths("M  staged.ts\0 M modified.ts\0D  deleted.ts\0?? new.ts\0R  renamed.ts\0old.ts\0")).toEqual([
			"staged.ts",
			"modified.ts",
			"deleted.ts",
			"new.ts",
			"renamed.ts",
			"old.ts",
		]);
	});

	it("masks the catalog before an agent turn when trusted project configuration enables it", async () => {
		const root = await temporaryDirectory("scion-project-");
		const cacheRoot = await temporaryDirectory("scion-skill-cache-");
		await mkdir(join(root, ".pi"), { recursive: true });
		await writeFile(join(root, ".pi", "scion.json"), '{"mode":"mask"}\n');
		const base = await createSkill(root, "systems-review", "Review architecture boundaries.");
		const rust = await createSkill(root, "rust-review", "Review Rust ownership.", "allowed-tools: rust_analyzer missing_tool\nmetadata:\n  depends_on: [systems-review]\n  domain_trigger: ['\\.rs$']\n");
		const docs = await createSkill(root, "documentation", "Write documentation.");
		const skills = [base, rust, docs];
		type BeforeHandler = (
			event: { prompt: string; systemPrompt: string; systemPromptOptions: BuildSystemPromptOptions },
			context: ExtensionContext,
		) => Promise<{ systemPrompt: string } | undefined>;
		const handlers = new Map<string, unknown>();
		const commands = new Map<string, { handler: (args: string, context: ExtensionContext) => Promise<void> }>();
		const statuses: Array<[string, string | undefined]> = [];
		const notifications: string[] = [];
		let activeTools = ["read"];
		const setActiveTools: string[][] = [];
		const api = {
			on: (name: string, handler: unknown) => handlers.set(name, handler),
			registerCommand: (name: string, command: { handler: (args: string, context: ExtensionContext) => Promise<void> }) => commands.set(name, command),
			getAllTools: () => [{ name: "read" }, { name: "rust_analyzer" }],
			getActiveTools: () => [...activeTools],
			setActiveTools: (names: string[]) => {
				activeTools = names;
				setActiveTools.push(names);
			},
			exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		};
		initializeScion(api as unknown as ExtensionAPI, {
			cacheRoot,
			gitStatus: async () => ["src/lib.rs"],
		});
		const skillCatalog = formatSkillsForPrompt(skills, "read");
		const event = {
			prompt: "Review ownership",
			systemPrompt: `Header${skillCatalog}\nCurrent working directory: ${root}`,
			systemPromptOptions: { cwd: root, selectedTools: ["read"], skills },
		};
		const context = {
			cwd: root,
			isProjectTrusted: () => true,
			ui: {
				notify: (message: string) => notifications.push(message),
				setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
			},
		} as unknown as ExtensionContext;
		await (handlers.get("session_start") as (event: unknown, context: ExtensionContext) => Promise<void>)({}, context);
		expect(statuses).toEqual([["scion", "♧ scion: waiting for first prompt"]]);
		const result = await (handlers.get("before_agent_start") as BeforeHandler)(event, context);
		expect(result?.systemPrompt).toContain("rust-review");
		expect(result?.systemPrompt).toContain("systems-review");
		expect(result?.systemPrompt).not.toContain("documentation");
		const estimatedTokens = Math.round((event.systemPrompt.length - result!.systemPrompt.length) / 4);
		expect(statuses.at(-1)).toEqual([
			"scion",
			`♧ scion: mask · skills synced · tools issues · ~${estimatedTokens.toLocaleString()} tok/req · ~0 tok session`,
		]);
		await (handlers.get("turn_start") as (event: unknown, context: ExtensionContext) => Promise<void>)({}, context);
		expect(statuses.at(-1)).toEqual([
			"scion",
			`♧ scion: mask · skills synced · tools issues · ~${estimatedTokens.toLocaleString()} tok/req · ~${estimatedTokens.toLocaleString()} tok session`,
		]);
		expect(setActiveTools).toEqual([["read", "rust_analyzer"]]);
		expect(activeTools).toEqual(["read", "rust_analyzer"]);
		await commands.get("scion:status")?.handler("", context);
		expect(notifications.at(-1)).toContain("Skills: synced");
		expect(notifications.at(-1)).toContain("Tools: issues (2 declared; selected: rust_analyzer)");
		expect(notifications.at(-1)).toContain(`~${estimatedTokens.toLocaleString()} tokens/session`);
		expect([...commands.keys()]).toEqual([
			"scion:status",
			"scion:explain",
			"scion:reindex",
		]);
	});

	it("activates linked tools for an explicitly invoked manual skill", async () => {
		const root = await temporaryDirectory("scion-project-");
		const cacheRoot = await temporaryDirectory("scion-skill-cache-");
		await mkdir(join(root, ".pi"), { recursive: true });
		await writeFile(join(root, ".pi", "scion.json"), '{"mode":"mask"}\n');
		const manual = await createSkill(root, "release", "Publish a release.", "allowed-tools: publish_release\n");
		manual.disableModelInvocation = true;
		type BeforeHandler = (
			event: { prompt: string; systemPrompt: string; systemPromptOptions: BuildSystemPromptOptions },
			context: ExtensionContext,
		) => Promise<{ systemPrompt: string } | undefined>;
		const handlers = new Map<string, unknown>();
		let activeTools = ["read"];
		const api = {
			on: (name: string, handler: unknown) => handlers.set(name, handler),
			registerCommand: () => undefined,
			getAllTools: () => [{ name: "read" }, { name: "publish_release" }],
			getActiveTools: () => [...activeTools],
			setActiveTools: (names: string[]) => { activeTools = names; },
			exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		};
		initializeScion(api as unknown as ExtensionAPI, { cacheRoot, gitStatus: async () => [] });
		const event = {
			prompt: `<skill name="release" location="${manual.filePath}">\nRelease instructions\n</skill>`,
			systemPrompt: "Header",
			systemPromptOptions: { cwd: root, selectedTools: ["read"], skills: [manual] },
		};
		const context = {
			cwd: root,
			isProjectTrusted: () => true,
			ui: { notify: () => undefined, setStatus: () => undefined },
		} as unknown as ExtensionContext;

		await (handlers.get("before_agent_start") as BeforeHandler)(event, context);
		expect(activeTools).toEqual(["read", "publish_release"]);
	});
});

describe("package entry point", () => {
	it("registers Scion's handlers and commands through the default export", () => {
		const handlers: string[] = [];
		const commands: string[] = [];
		const api = {
			on: (name: string) => handlers.push(name),
			registerCommand: (name: string) => commands.push(name),
			getAllTools: () => [],
			getActiveTools: () => [],
			setActiveTools: () => undefined,
			exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		};

		scion(api as unknown as ExtensionAPI);

		expect(handlers).toEqual(["before_agent_start", "turn_start", "tool_result", "session_start"]);
		expect(commands).toEqual(["scion:status", "scion:explain", "scion:reindex"]);
	});
});

describe("graph construction from cached metadata", () => {
	it("accepts pre-parsed metadata", async () => {
		const root = await temporaryDirectory("scion-skills-");
		const skill = await createSkill(root, "typescript", "Work with TypeScript.");
		const metadata = new Map<string, SkillMetadataResult>([
			["typescript", { metadata: { dependsOn: [], domainTriggers: [{ kind: "regex", pattern: "\\.ts$" }], toolNames: [] }, diagnostics: [] }],
		]);
		expect(buildSkillDependencyGraph([skill], metadata).nodes.get("typescript")?.domainTriggers).toEqual([
			{ kind: "regex", pattern: "\\.ts$" },
		]);
	});
});
