// Breaks a captured request into the parts Scion can change.
import { readFileSync } from "node:fs";

function systemText(body) {
	const system = body.system;
	if (Array.isArray(system)) return system.map((part) => part.text ?? "").join("");
	return system ?? "";
}

function measure(path) {
	const { body } = JSON.parse(readFileSync(path, "utf8"));
	const system = systemText(body);
	const tools = body.tools ?? [];
	return {
		total: JSON.stringify(body).length,
		tools: JSON.stringify(tools).length,
		toolCount: tools.length,
		toolNames: tools.map((tool) => tool.name).sort(),
		system: system.length,
		catalog: (/<available_skills>[\s\S]*?<\/available_skills>/.exec(system)?.[0] ?? "").length,
	};
}

const files = process.argv.slice(2);
if (files.length === 0) {
	console.error("usage: node bench/report.mjs <capture.json>...");
	process.exit(1);
}

const pad = (value, width) => String(value).padStart(width);
console.log(`${"capture".padEnd(22)}${pad("request", 10)}${pad("tools", 10)}${pad("n", 4)}${pad("catalog", 10)}`);
for (const file of files) {
	const m = measure(file);
	const label = file.replace(/^.*\//, "").replace(/\.json$/, "");
	console.log(`${label.padEnd(22)}${pad(m.total, 10)}${pad(m.tools, 10)}${pad(m.toolCount, 4)}${pad(m.catalog, 10)}`);
}
if (files.length === 1) console.log(`\ntools: ${measure(files[0]).toolNames.join(", ")}`);
