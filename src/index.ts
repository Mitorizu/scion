import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initializeScion } from "./extension.js";

export default function scion(pi: ExtensionAPI): void {
	initializeScion(pi);
}

export { initializeScion, parseGitStatusPaths, SCION_FIND_TOOLS, type ScionOptions } from "./extension.js";
export { planToolBudget, type BudgetTool, type ToolBudgetInput } from "./tool-budget.js";
export { rankTools, type SearchableTool, type ToolMatch } from "./tool-search.js";
export {
	discriminativeWords,
	documentFrequency,
	inverseDocumentFrequency,
	words,
} from "./lexical.js";
export {
	buildSkillDependencyGraph,
	indexSkillDirectory,
	indexSkills,
	parseSkillMetadata,
} from "./indexer.js";
export {
	loadScionConfig,
	maskSkillCatalog,
	ScionManager,
	type GraphLoadResult,
	type PromptMaskResult,
	type ScionManagerOptions,
} from "./manager.js";
export { resolveLinkedTools, routeSkills } from "./router.js";
export {
	compileToolRegistry,
	compileToolSchema,
	compileToolSchemaJson,
	normalizeToolDefinition,
	parseToolDefinition,
	type CompileToolOptions,
	type JsonSchema,
	type JsonToolDefinition,
	type OpenAiToolDefinition,
	type ToolDefinition,
} from "./tool-compiler.js";
export {
	HashingTextEmbedder,
	ToolIndex,
	type IndexedTool,
	type TextEmbedder,
	type ToolSearchResult,
} from "./tool-index.js";
export * from "./types.js";
