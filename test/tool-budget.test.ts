import { describe, expect, it } from "vitest";
import { planToolBudget, type BudgetTool } from "../src/tool-budget.js";

const LOADER = "winnow_find_tools";

const TOOLS: BudgetTool[] = [
	{ name: "read", builtin: true },
	{ name: "bash", builtin: true },
	{ name: "edit", builtin: true },
	{ name: "powershell", builtin: true },
	{ name: "rust_analyzer", builtin: false },
	{ name: "graft_find_code", builtin: false },
	{ name: "github_search", builtin: false },
	{ name: LOADER, builtin: false },
];

// Pi leaves powershell inactive on this host, so it never reaches the request.
const BASELINE = ["read", "bash", "edit", "rust_analyzer", "graft_find_code", "github_search", LOADER];

describe("tool budget", () => {
	it("keeps built-ins and the loader, and withholds unrelated extension tools", () => {
		const plan = planToolBudget({
			allTools: TOOLS,
			baselineNames: BASELINE,
			linkedNames: [],
			activatedNames: [],
			loaderName: LOADER,
		});

		expect(plan.keepNames).toEqual(["read", "bash", "edit", LOADER]);
		expect(plan.droppedNames).toEqual(["rust_analyzer", "graft_find_code", "github_search"]);
	});

	it("keeps a tool a selected skill links", () => {
		const plan = planToolBudget({
			allTools: TOOLS,
			baselineNames: BASELINE,
			linkedNames: ["rust_analyzer"],
			activatedNames: [],
			loaderName: LOADER,
		});

		expect(plan.keepNames).toContain("rust_analyzer");
		expect(plan.keeps.find((keep) => keep.name === "rust_analyzer")?.reason).toBe("skill-linked");
		expect(plan.droppedNames).toEqual(["graft_find_code", "github_search"]);
	});

	it("does not force on a built-in the user disabled", () => {
		const plan = planToolBudget({
			allTools: TOOLS,
			baselineNames: BASELINE.filter((name) => name !== "bash"),
			linkedNames: [],
			activatedNames: [],
			loaderName: LOADER,
		});

		expect(plan.keepNames).not.toContain("bash");
		expect(plan.droppedNames).not.toContain("bash");
	});

	it("keeps everything activated earlier in the session so the set only grows", () => {
		const first = planToolBudget({
			allTools: TOOLS,
			baselineNames: BASELINE,
			linkedNames: ["rust_analyzer"],
			activatedNames: [],
			loaderName: LOADER,
		});
		// A later turn selects a different skill that links nothing.
		const second = planToolBudget({
			allTools: TOOLS,
			baselineNames: BASELINE,
			linkedNames: [],
			activatedNames: ["rust_analyzer", "graft_find_code"],
			loaderName: LOADER,
		});

		expect(second.keepNames).toEqual(expect.arrayContaining([...first.keepNames]));
		expect(second.keepNames).toContain("graft_find_code");
		expect(second.keeps.find((keep) => keep.name === "graft_find_code")?.reason).toBe("activated");
		expect(second.droppedNames).toEqual(["github_search"]);
	});

	it("ignores names that are not registered", () => {
		const plan = planToolBudget({
			allTools: TOOLS,
			baselineNames: BASELINE,
			linkedNames: ["ghost_tool"],
			activatedNames: ["another_ghost"],
			loaderName: LOADER,
		});

		expect(plan.keepNames).not.toContain("ghost_tool");
		expect(plan.keepNames).not.toContain("another_ghost");
	});
});
