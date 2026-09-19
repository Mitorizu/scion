import { performance } from "node:perf_hooks";
import {
	parseSkillBlock,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionContext,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import {
	loadScionConfig,
	maskSkillCatalog,
	ScionManager,
	type ScionManagerOptions,
} from "./manager.js";
import { resolveLinkedTools, routeSkills } from "./router.js";
import type { ScionSnapshot } from "./types.js";

export interface ScionOptions extends ScionManagerOptions {
	gitStatus?: (cwd: string) => Promise<readonly string[]>;
}

const SCION_STATUS_LABEL = "♧ scion";

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

function formatSnapshot(snapshot: ScionSnapshot | undefined): string {
	if (!snapshot) return "Scion has not routed a turn yet.";
	const selected = snapshot.selectedNames.length > 0 ? snapshot.selectedNames.join(", ") : "none";
	const linkedTools = snapshot.linkedToolNames.length > 0 ? snapshot.linkedToolNames.join(", ") : "none";
	const skillsSynced = snapshot.diagnostics.length === 0 && snapshot.disabledNodeCount === 0;
	const toolsSynced = snapshot.unavailableToolNames.length === 0;
	const lines = [
		`Mode: ${snapshot.mode}`,
		`Selected skills: ${selected}`,
		`Skills: ${skillsSynced ? "synced" : "issues"} (${snapshot.graphNodeCount} active, ${snapshot.disabledNodeCount} disabled)`,
		`Tools: ${toolsSynced ? "synced" : "issues"} (${snapshot.declaredToolCount} declared; selected: ${linkedTools})`,
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

function refreshStatus(ctx: ExtensionContext, snapshot: ScionSnapshot): void {
	const skills = snapshot.diagnostics.length === 0 && snapshot.disabledNodeCount === 0 ? "skills synced" : "skills issues";
	const tools = snapshot.unavailableToolNames.length === 0 ? "tools synced" : "tools issues";
	const savings = snapshot.masked
		? ` · ~${snapshot.estimatedTokensSavedPerRequest.toLocaleString()} tok/req · ~${snapshot.estimatedTokensSavedSession.toLocaleString()} tok session`
		: "";
	ctx.ui.setStatus("scion", `${SCION_STATUS_LABEL}: ${snapshot.mode} · ${skills} · ${tools}${savings}`);
}

function formatExplanation(snapshot: ScionSnapshot | undefined): string {
	if (!snapshot) return "Scion has not routed a turn yet.";
	const lines = [formatSnapshot(snapshot)];
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

export function initializeScion(pi: ExtensionAPI, options: ScionOptions = {}): void {
	const manager = new ScionManager(options);
	const changedByTools = new Set<string>();
	let latest: ScionSnapshot | undefined;
	let estimatedTokensSavedSession = 0;
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
		const availableToolNames = pi.getAllTools().map((tool) => tool.name);
		const toolRoute = resolveLinkedTools(graphLoad.graph, route.selectedNames, availableToolNames);
		const allToolLinks = resolveLinkedTools(graphLoad.graph, [...graphLoad.graph.nodes.keys()], availableToolNames);
		const config = loadScionConfig(ctx.cwd, ctx.isProjectTrusted());
		if (config.mode === "mask" && toolRoute.linkedToolNames.length > 0) {
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
		};
		refreshStatus(ctx, latest);
		return config.mode === "mask" && masked ? { systemPrompt } : undefined;
	});

	pi.on("turn_start", (_event, ctx) => {
		if (!latest?.masked || latest.estimatedTokensSavedPerRequest === 0) return;
		estimatedTokensSavedSession += latest.estimatedTokensSavedPerRequest;
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
		ctx.ui.setStatus("scion", `${SCION_STATUS_LABEL}: waiting for first prompt`);
	});

	pi.registerCommand("scion:status", {
		description: "Show Scion mode, selected skills, linked tools, savings, and timing",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatSnapshot(latest), "info");
		},
	});

	pi.registerCommand("scion:explain", {
		description: "Explain Scion's latest skill and tool selection",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatExplanation(latest), "info");
		},
	});

	pi.registerCommand("scion:reindex", {
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
