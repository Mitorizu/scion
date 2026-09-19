import { describe, expect, it } from "vitest";
import { rankTools, type SearchableTool } from "../src/tool-search.js";

// The tools Scion withheld in the live capture that first exposed the problem.
const WITHHELD: SearchableTool[] = [
	{ name: "grep", description: "Search file contents for a pattern. Returns matching lines with file paths and line numbers." },
	{ name: "find", description: "Search for files by glob pattern. Returns matching file paths relative to the search directory." },
	{ name: "ls", description: "List directory contents." },
	{ name: "github_search_tools", description: "Search GitHub Actions MCP method names and descriptions." },
	{ name: "github_list_methods", description: "List methods from the read-only GitHub Actions MCP server." },
	{ name: "github_describe_tool", description: "Show one GitHub Actions MCP method schema and make it callable." },
	{ name: "glean_search_tools", description: "Search Glean MCP method names and descriptions." },
	{ name: "glean_list_methods", description: "List the names of methods available from the company Glean MCP server." },
	{ name: "glean_describe_tool", description: "Show one Glean MCP method schema and make it callable." },
	{ name: "AskClaude", description: "Delegate a question to Claude and return the answer." },
];

describe("tool search", () => {
	it("prefers the rare word over the shared verb", () => {
		const matches = rankTools("search GitHub issues and pull requests", WITHHELD, 2);

		expect(matches.map((match) => match.name)).toEqual(["github_search_tools", "github_describe_tool"]);
		expect(matches.map((match) => match.name)).not.toContain("grep");
	});

	it("still finds a plain file search when that is what was asked", () => {
		expect(rankTools("grep the repository for a pattern", WITHHELD, 1)[0]?.name).toBe("grep");
		expect(rankTools("list directory contents", WITHHELD, 1)[0]?.name).toBe("ls");
	});

	it("separates two vendors that share the same verbs", () => {
		expect(rankTools("glean search", WITHHELD, 1)[0]?.name).toBe("glean_search_tools");
		// Every github tool matches "github actions" equally, so assert the vendor
		// rather than pretend the tie between them is meaningful.
		expect(rankTools("github actions", WITHHELD, 3).map((match) => match.name))
			.toEqual(["github_describe_tool", "github_list_methods", "github_search_tools"]);
	});

	it("returns nothing when no word matches", () => {
		expect(rankTools("xyzzy plugh", WITHHELD)).toEqual([]);
		expect(rankTools("anything", [])).toEqual([]);
	});
});
