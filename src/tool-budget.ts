import type { ToolBudgetResult, ToolKeep, ToolKeepReason } from "./types.js";

export interface BudgetTool {
	name: string;
	builtin: boolean;
}

export interface ToolBudgetInput {
	/** Every tool Pi has registered, tagged with whether Pi owns it. */
	allTools: readonly BudgetTool[];
	/** The active set as Pi built it, captured before Winnow first changed it. */
	baselineNames: readonly string[];
	/** `allowed-tools` of the skills selected for this turn. */
	linkedNames: readonly string[];
	/** Tools Winnow already activated earlier in this session. */
	activatedNames: readonly string[];
	/** Winnow's discovery tool, which stays active so dropped tools stay reachable. */
	loaderName: string;
}

/**
 * Decide which tool schemas this turn pays for.
 *
 * Built-in tools are kept because the agent cannot work without them, but only
 * when Pi had them active: a user who disabled one keeps it disabled. Linked
 * tools are kept whether or not Pi had them active, which preserves Winnow's
 * existing skill-to-tool activation. Everything Winnow activated earlier in the
 * session is kept so the set only ever grows, which is what lets a provider
 * reuse the cached prompt prefix across turns.
 */
export function planToolBudget(input: ToolBudgetInput): ToolBudgetResult {
	const registered = new Map(input.allTools.map((tool) => [tool.name, tool]));
	const baseline = new Set(input.baselineNames);
	const linked = new Set(input.linkedNames.filter((name) => registered.has(name)));
	const activated = new Set(input.activatedNames.filter((name) => registered.has(name)));

	const reasonFor = (tool: BudgetTool): ToolKeepReason | undefined => {
		if (tool.name === input.loaderName) return "loader";
		if (tool.builtin && baseline.has(tool.name)) return "builtin";
		if (linked.has(tool.name)) return "skill-linked";
		if (activated.has(tool.name)) return "activated";
		return undefined;
	};

	const keeps: ToolKeep[] = [];
	const droppedNames: string[] = [];
	for (const tool of input.allTools) {
		const reason = reasonFor(tool);
		if (reason) keeps.push({ name: tool.name, reason });
		else if (baseline.has(tool.name)) droppedNames.push(tool.name);
	}
	return {
		keepNames: keeps.map((keep) => keep.name),
		keeps,
		droppedNames,
	};
}
