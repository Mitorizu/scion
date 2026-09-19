import { performance } from "node:perf_hooks";
import {
	parseSkillBlock,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionContext,
	type Skill,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	loadWinnowConfig,
	maskSkillCatalog,
	WinnowManager,
	type WinnowManagerOptions,
} from "./manager.js";
import { resolveLinkedTools, routeSkills } from "./router.js";
import { planToolBudget } from "./tool-budget.js";
import { rankTools } from "./tool-search.js";
import type { WinnowSnapshot } from "./types.js";

export interface WinnowOptions extends WinnowManagerOptions {
	gitStatus?: (cwd: string) => Promise<readonly string[]>;
}

const WINNOW_STATUS_LABEL = "♧ winnow";
export const WINNOW_FIND_TOOLS = "winnow_find_tools";

function budgetTools(tools: readonly ToolInfo[]): { name: string; builtin: boolean }[] {
	return tools.map((tool) => ({ name: tool.name, builtin: tool.sourceInfo.source === "builtin" }));
}

/** Rough schema cost of the tools Winnow left out of the request. */
function estimatedToolTokens(tools: readonly ToolInfo[], names: readonly string[]): number {
	const dropped = new Set(names);
	const bytes = tools
		.filter((tool) => dropped.has(tool.name))
		.reduce((total, tool) => total + JSON.stringify({
			name: tool.name,
			description: tool.description,
			input_schema: tool.parameters,
		}).length, 0);
	return Math.round(bytes / 4);
}

export function parseGitStatusPaths(output: string): string[] {
	const records = output.split("\0");
	const paths: string[] = [];
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (!record || record.length < 4) continue;
		const status = record.slice(0, 2);
		paths.push(record.slice(3));
		if (/[RC]/u.test(status)) {
			const previousPath = records[index + 1];
			if (previousPath) paths.push(previousPath);
			index += 1;
		}
	}
	return [...new Set(paths)];
}

function visibleSkills(options: BuildSystemPromptOptions): Skill[] {
	return (options.skills ?? []).filter((skill) => !skill.disableModelInvocation);
}

function fileReadTool(options: BuildSystemPromptOptions): "read" | "bash" | undefined {
	const tools = options.selectedTools ?? [];
	if (tools.includes("read")) return "read";
	if (tools.includes("bash")) return "bash";
	return undefined;
}

function formatSnapshot(snapshot: WinnowSnapshot | undefined): string {
	if (!snapshot) return "Winnow has not routed a turn yet.";
	const selected = snapshot.selectedNames.length > 0 ? snapshot.selectedNames.join(", ") : "none";
	const linkedTools = snapshot.linkedToolNames.length > 0 ? snapshot.linkedToolNames.join(", ") : "none";
	const skillsSynced = snapshot.diagnostics.length === 0 && snapshot.disabledNodeCount === 0;
	const toolsSynced = snapshot.unavailableToolNames.length === 0;
	const lines = [
		`Mode: ${snapshot.mode}`,
		`Selected skills: ${selected}`,
		`Skills: ${skillsSynced ? "synced" : "issues"} (${snapshot.graphNodeCount} active, ${snapshot.disabledNodeCount} disabled)`,
		`Tools: ${toolsSynced ? "synced" : "issues"} (${snapshot.declaredToolCount} declared; selected: ${linkedTools})`,
		`Tool policy: ${snapshot.toolPolicy}${snapshot.toolPolicy === "linked" ? ` (${snapshot.droppedToolNames.length} withheld, ~${snapshot.estimatedToolTokensSaved.toLocaleString()} tokens/request)` : ""}`,
		`Prompt masked: ${snapshot.masked ? "yes" : "no"}`,
		`Estimated savings: ~${snapshot.estimatedTokensSavedPerRequest.toLocaleString()} tokens/request, ~${snapshot.estimatedTokensSavedSession.toLocaleString()} tokens/session`,
		`Timing: ${snapshot.totalDurationMs.toFixed(2)} ms total (${snapshot.indexDurationMs.toFixed(2)} ms index, ${snapshot.routeDurationMs.toFixed(2)} ms route)`,
	];
	if (!toolsSynced) lines.push(`Unavailable linked tools: ${snapshot.unavailableToolNames.join(", ")}`);
	return lines.join("\n");
}

function estimatedTokensRemoved(before: string, after: string): number {
	return Math.max(0, Math.round((before.length - after.length) / 4));
}

function refreshStatus(ctx: ExtensionContext, snapshot: WinnowSnapshot): void {
	const skills = snapshot.diagnostics.length === 0 && snapshot.disabledNodeCount === 0 ? "skills synced" : "skills issues";
	const tools = snapshot.unavailableToolNames.length === 0 ? "tools synced" : "tools issues";
	const perRequest = snapshot.estimatedTokensSavedPerRequest + snapshot.estimatedToolTokensSaved;
	const savings = snapshot.masked || snapshot.droppedToolNames.length > 0
		? ` · ~${perRequest.toLocaleString()} tok/req · ~${snapshot.estimatedTokensSavedSession.toLocaleString()} tok session`
		: "";
	const withheld = snapshot.droppedToolNames.length > 0 ? ` · ${snapshot.droppedToolNames.length} tools withheld` : "";
	ctx.ui.setStatus("winnow", `${WINNOW_STATUS_LABEL}: ${snapshot.mode} · ${skills} · ${tools}${withheld}${savings}`);
}

function formatExplanation(snapshot: WinnowSnapshot | undefined): string {
	if (!snapshot) return "Winnow has not routed a turn yet.";
	const lines = [formatSnapshot(snapshot)];
	if (snapshot.droppedToolNames.length > 0) {
		lines.push("", `Withheld tools (call ${WINNOW_FIND_TOOLS} to restore):`, ...snapshot.droppedToolNames.map((name) => `- ${name}`));
	}
	if (snapshot.changedPaths.length > 0) lines.push("", "Changed paths:", ...snapshot.changedPaths.map((path) => `- ${path}`));
	if (snapshot.matches.length > 0) {
		lines.push("", "Selection reasons:");
		for (const match of snapshot.matches) {
			lines.push(`- ${match.name} (${match.score})`);
			for (const reason of match.reasons) lines.push(`  - ${reason.detail}`);
		}
	}
	if (snapshot.diagnostics.length > 0) {
		lines.push("", "Graph diagnostics:");
		for (const diagnostic of snapshot.diagnostics) lines.push(`- ${diagnostic.skill}: ${diagnostic.message}`);
	}
	return lines.join("\n");
}

export function initializeWinnow(pi: ExtensionAPI, options: WinnowOptions = {}): void {
	const manager = new WinnowManager(options);
	const changedByTools = new Set<string>();
	let latest: WinnowSnapshot | undefined;
	let estimatedTokensSavedSession = 0;
	// The active set Pi built, captured once before Winnow narrows it.
	let baselineToolNames: readonly string[] | undefined;
	// Grows only, so a provider can keep reusing the cached prompt prefix.
	const activatedToolNames = new Set<string>();
	let loaderRegistered = false;

	const registerLoader = (): void => {
		if (loaderRegistered) return;
		loaderRegistered = true;
		pi.registerTool({
			name: WINNOW_FIND_TOOLS,
			label: "Find Tools",
			description: "Search the tools Winnow withheld from this request and activate the best matches. Call this when a task needs a capability the active tools do not provide.",
			parameters: Type.Object({
				query: Type.String({ description: "What the tool needs to do, in plain words." }),
				limit: Type.Optional(Type.Number({ description: "How many tools to activate. Defaults to 3." })),
			}),
			async execute(_toolCallId, params) {
				const active = new Set(pi.getActiveTools());
				const candidates = pi.getAllTools().filter((tool) => !active.has(tool.name));
				if (candidates.length === 0) {
					return { content: [{ type: "text", text: "Every registered tool is already active." }], details: {} };
				}
				const matches = rankTools(
					params.query,
					candidates.map((tool) => ({ name: tool.name, description: tool.description })),
					params.limit ?? 3,
				);
				if (matches.length === 0) {
					const names = candidates.map((tool) => tool.name).join(", ");
					return { content: [{ type: "text", text: `No withheld tool matched that query. Available to activate: ${names}.` }], details: {} };
				}
				for (const match of matches) activatedToolNames.add(match.name);
				pi.setActiveTools([...new Set([...pi.getActiveTools(), ...matches.map((match) => match.name)])]);
				const listed = matches.map((match) => `- ${match.name}: ${match.description}`).join("\n");
				return { content: [{ type: "text", text: `Activated ${matches.length} tool(s):\n${listed}` }], details: {} };
			},
		});
	};

	const readGitStatus = options.gitStatus ?? (async (cwd: string): Promise<readonly string[]> => {
		try {
			const result = await pi.exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
				timeout: 35,
			});
			return result.code === 0 ? parseGitStatusPaths(result.stdout) : [];
		} catch {
			return [];
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const startedAt = performance.now();
		const skills = event.systemPromptOptions.skills ?? [];
		const catalogSkills = visibleSkills(event.systemPromptOptions);
		const graphLoad = manager.loadGraph(ctx.cwd, skills);
		const gitPaths = await readGitStatus(ctx.cwd);
		const changedPaths = [...new Set([...gitPaths, ...changedByTools])];
		const explicitSkillName = parseSkillBlock(event.prompt)?.name;
		const route = routeSkills(graphLoad.graph, {
			prompt: event.prompt,
			changedPaths,
			...(explicitSkillName ? { explicitSkillName } : {}),
		});
		const config = loadWinnowConfig(ctx.cwd, ctx.isProjectTrusted());
		if (config.mode === "mask" && config.tools === "linked") registerLoader();
		const allTools = pi.getAllTools();
		const availableToolNames = allTools.map((tool) => tool.name);
		const toolRoute = resolveLinkedTools(graphLoad.graph, route.selectedNames, availableToolNames);
		const allToolLinks = resolveLinkedTools(graphLoad.graph, [...graphLoad.graph.nodes.keys()], availableToolNames);
		let droppedToolNames: readonly string[] = [];
		if (config.mode === "mask" && config.tools === "linked") {
			baselineToolNames ??= pi.getActiveTools();
			for (const name of toolRoute.linkedToolNames) activatedToolNames.add(name);
			const plan = planToolBudget({
				allTools: budgetTools(allTools),
				baselineNames: baselineToolNames,
				linkedNames: toolRoute.linkedToolNames,
				activatedNames: [...activatedToolNames],
				loaderName: WINNOW_FIND_TOOLS,
			});
			droppedToolNames = plan.droppedNames;
			pi.setActiveTools([...plan.keepNames]);
		} else if (config.mode === "mask" && toolRoute.linkedToolNames.length > 0) {
			const activeTools = pi.getActiveTools();
			const activeSet = new Set(activeTools);
			const additions = toolRoute.linkedToolNames.filter((name) => !activeSet.has(name));
			if (additions.length > 0) pi.setActiveTools([...activeTools, ...additions]);
		}
		const originalSystemPrompt = event.systemPrompt;
		let systemPrompt = originalSystemPrompt;
		let masked = false;
		const readTool = fileReadTool(event.systemPromptOptions);
		if (config.mode === "mask" && readTool) {
			const result = maskSkillCatalog(systemPrompt, catalogSkills, route.selectedNames, readTool);
			systemPrompt = result.systemPrompt;
			masked = result.masked;
		}
		latest = {
			mode: config.mode,
			selectedNames: route.selectedNames,
			matches: route.matches,
			linkedToolNames: toolRoute.linkedToolNames,
			unavailableToolNames: allToolLinks.unavailableToolNames,
			declaredToolCount: allToolLinks.linkedToolNames.length + allToolLinks.unavailableToolNames.length,
			changedPaths,
			graphNodeCount: graphLoad.graph.nodes.size,
			disabledNodeCount: graphLoad.graph.disabledNodes.size,
			diagnostics: graphLoad.graph.diagnostics,
			indexDurationMs: graphLoad.durationMs,
			routeDurationMs: route.durationMs,
			totalDurationMs: performance.now() - startedAt,
			masked,
			estimatedTokensSavedPerRequest: masked ? estimatedTokensRemoved(originalSystemPrompt, systemPrompt) : 0,
			estimatedTokensSavedSession,
			toolPolicy: config.tools,
			droppedToolNames,
			estimatedToolTokensSaved: estimatedToolTokens(allTools, droppedToolNames),
		};
		refreshStatus(ctx, latest);
		return config.mode === "mask" && masked ? { systemPrompt } : undefined;
	});

	pi.on("turn_start", (_event, ctx) => {
		if (!latest) return;
		const perRequest = latest.estimatedTokensSavedPerRequest + latest.estimatedToolTokensSaved;
		if (perRequest === 0) return;
		estimatedTokensSavedSession += perRequest;
		latest = { ...latest, estimatedTokensSavedSession };
		refreshStatus(ctx, latest);
	});

	pi.on("tool_result", (event) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const input = event.input as { path?: unknown };
		if (typeof input.path === "string" && input.path.trim() !== "") changedByTools.add(input.path);
	});

	pi.on("session_start", (_event, ctx) => {
		changedByTools.clear();
		latest = undefined;
		estimatedTokensSavedSession = 0;
		baselineToolNames = undefined;
		activatedToolNames.clear();
		ctx.ui.setStatus("winnow", `${WINNOW_STATUS_LABEL}: waiting for first prompt`);
	});

	pi.registerCommand("winnow:status", {
		description: "Show Winnow mode, selected skills, linked tools, savings, and timing",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatSnapshot(latest), "info");
		},
	});

	pi.registerCommand("winnow:explain", {
		description: "Explain Winnow's latest skill and tool selection",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatExplanation(latest), "info");
		},
	});

	pi.registerCommand("winnow:reindex", {
		description: "Delete the skill metadata cache and rebuild the dependency graph",
		handler: async (_args, ctx) => {
			manager.invalidate(ctx.cwd);
			const result = manager.loadGraph(ctx.cwd, ctx.getSystemPromptOptions().skills ?? []);
			ctx.ui.notify(
				`Skill graph rebuilt: ${result.graph.nodes.size} active, ${result.graph.disabledNodes.size} disabled.`,
				"info",
			);
		},
	});
}
