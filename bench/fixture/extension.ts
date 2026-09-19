// Fixture for the benchmark. Points Pi at the local capture server and
// registers a tool set sized like a real one, so the measurement does not
// depend on whichever extensions happen to be installed on the machine.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PORT = Number(process.env.WINNOW_BENCH_PORT ?? 8788);

interface FixtureTool {
	name: string;
	description: string;
	fields: [string, string][];
}

const TOOLS: FixtureTool[] = [
	{
		name: "code_search",
		description: "Search indexed source code for a symbol, definition, or usage. Returns ranked file paths with line numbers and the enclosing symbol. Results are capped at 100 matches.",
		fields: [["query", "What to look for, as a symbol name or plain words."], ["path", "Limit results to this directory prefix."]],
	},
	{
		name: "code_references",
		description: "List every reference to a symbol across the indexed repository, including call sites, imports, and re-exports. Use before renaming or deleting a symbol.",
		fields: [["symbol", "Fully qualified symbol name."], ["direction", "Either inbound or outbound references."]],
	},
	{
		name: "code_file_outline",
		description: "Return the signatures in one file without its bodies. Cheaper than reading the file when you only need to know what it exports.",
		fields: [["file", "Repository-relative path to the file."]],
	},
	{
		name: "code_repo_map",
		description: "Summarize the repository as directory clusters with the most connected files in each. Use when starting work in an unfamiliar tree.",
		fields: [["max_dirs", "How many directories to include."]],
	},
	{
		name: "code_index_status",
		description: "Report whether the code index matches the working tree and list the files that drifted.",
		fields: [],
	},
	{
		name: "issue_search",
		description: "Search the issue tracker for issues and pull requests by keyword, label, author, or state. Returns issue numbers, titles, and states.",
		fields: [["query", "Search terms, optionally with label: and author: filters."], ["state", "Filter by open, closed, or all."]],
	},
	{
		name: "issue_read",
		description: "Read one issue or pull request, including its body, labels, and comment thread.",
		fields: [["number", "The issue or pull request number."]],
	},
	{
		name: "issue_list_projects",
		description: "List the projects and repositories the issue tracker credential can reach.",
		fields: [],
	},
	{
		name: "docs_search",
		description: "Search the company knowledge base for documents, runbooks, and design records. Returns titles with excerpts and permalinks.",
		fields: [["query", "What you want to find, in plain words."], ["limit", "How many documents to return."]],
	},
	{
		name: "docs_read",
		description: "Fetch the full text of one knowledge base document by its permalink.",
		fields: [["url", "Permalink returned by docs_search."]],
	},
	{
		name: "docs_list_spaces",
		description: "List the knowledge base spaces available to the current credential.",
		fields: [],
	},
	{
		name: "deploy_status",
		description: "Report the current deployment state for a service across environments, including the running version and the last successful rollout.",
		fields: [["service", "Service name as registered in the deployment catalog."], ["environment", "Environment to inspect."]],
	},
	{
		name: "metrics_query",
		description: "Run a time series query against the metrics backend and return aggregated points. Use for latency, error rate, and saturation questions.",
		fields: [["query", "Query in the metrics backend's expression language."], ["window", "Lookback window such as 1h or 7d."]],
	},
	{
		name: "delegate_task",
		description: "Hand a bounded, self-contained task to a separate agent and return its result. Use for work that would otherwise fill this conversation with output you do not need to read. The delegate does not share this conversation's context, so state the task in full.",
		fields: [["task", "The complete task statement, including acceptance criteria."], ["repository", "Repository the delegate should work in."], ["timeout_minutes", "How long the delegate may run."]],
	},
];

export default function benchFixture(pi: ExtensionAPI): void {
	pi.registerProvider("anthropic", { baseUrl: `http://127.0.0.1:${PORT}` });

	for (const tool of TOOLS) {
		const shape = Object.fromEntries(
			tool.fields.map(([field, description]) => [field, Type.Optional(Type.String({ description }))]),
		);
		pi.registerTool({
			name: tool.name,
			label: tool.name,
			description: tool.description,
			parameters: Type.Object(shape),
			async execute() {
				return { content: [{ type: "text", text: "fixture" }], details: {} };
			},
		});
	}
}
