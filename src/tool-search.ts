import { inverseDocumentFrequency, words } from "./lexical.js";

export interface SearchableTool {
	name: string;
	description: string;
}

export interface ToolMatch {
	name: string;
	description: string;
	score: number;
}

/** A word in the tool's own name is a stronger signal than one in its prose. */
const NAME_WEIGHT = 2;

function documentFor(tool: SearchableTool): string {
	return `${tool.name} ${tool.description}`;
}

/**
 * Rank withheld tools against a query by inverse document frequency.
 *
 * Weighting by rarity is what separates the tool the caller means from the one
 * that merely shares a verb. "Search GitHub issues" should not return `grep`
 * just because both descriptions say "search".
 */
export function rankTools(query: string, tools: readonly SearchableTool[], limit = 3): ToolMatch[] {
	if (tools.length === 0) return [];
	const weights = inverseDocumentFrequency(tools.map(documentFor));
	const queryTokens = new Set(words(query));
	const ranked: ToolMatch[] = [];
	for (const tool of tools) {
		const nameTokens = new Set(words(tool.name));
		const bodyTokens = new Set(words(tool.description));
		let score = 0;
		for (const token of queryTokens) {
			const weight = weights.get(token);
			if (weight === undefined) continue;
			if (nameTokens.has(token)) score += weight * NAME_WEIGHT;
			else if (bodyTokens.has(token)) score += weight;
		}
		if (score > 0) ranked.push({ name: tool.name, description: tool.description, score });
	}
	return ranked
		.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
		.slice(0, Math.max(1, Math.trunc(limit)));
}
