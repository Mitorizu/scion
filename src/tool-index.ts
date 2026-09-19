import {
	compileToolSchema,
	normalizeToolDefinition,
	type ToolDefinition,
} from "./tool-compiler.js";

export interface TextEmbedder {
	embed(text: string): Promise<readonly number[]> | readonly number[];
}

export interface IndexedTool {
	name: string;
	description: string;
	declaration: string;
	tool: ToolDefinition;
}

export interface ToolSearchResult extends IndexedTool {
	score: number;
}

interface VectorEntry extends IndexedTool {
	vector: readonly number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaTerms(value: unknown, output: string[], depth = 0): void {
	if (depth > 16 || !isRecord(value)) return;
	if (typeof value.description === "string") output.push(value.description);
	if (Array.isArray(value.enum)) output.push(value.enum.filter((entry): entry is string => typeof entry === "string").join(" "));
	if (isRecord(value.properties)) {
		for (const [name, property] of Object.entries(value.properties)) {
			output.push(name);
			schemaTerms(property, output, depth + 1);
		}
	}
	if (isRecord(value.items)) schemaTerms(value.items, output, depth + 1);
	for (const key of ["oneOf", "anyOf"] as const) {
		if (Array.isArray(value[key])) for (const entry of value[key]) schemaTerms(entry, output, depth + 1);
	}
}

function searchableText(tool: ToolDefinition): string {
	const definition = normalizeToolDefinition(tool);
	const terms = [definition.name, definition.description ?? ""];
	schemaTerms(definition.parameters ?? definition.inputSchema, terms);
	return terms.join(" ");
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
	if (left.length !== right.length || left.length === 0) return 0;
	let dot = 0;
	let leftMagnitude = 0;
	let rightMagnitude = 0;
	for (let index = 0; index < left.length; index += 1) {
		const a = left[index] ?? 0;
		const b = right[index] ?? 0;
		dot += a * b;
		leftMagnitude += a * a;
		rightMagnitude += b * b;
	}
	if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
	return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function hashToken(token: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < token.length; index += 1) {
		hash ^= token.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/**
 * Dependency-free feature hashing for local examples and tests. Replace this
 * with an embedding API for semantic similarity without changing ToolIndex.
 */
export class HashingTextEmbedder implements TextEmbedder {
	constructor(private readonly dimensions = 384) {
		if (!Number.isInteger(dimensions) || dimensions < 8) throw new Error("Embedding dimensions must be an integer of at least 8.");
	}

	embed(text: string): readonly number[] {
		const vector = Array.from<number>({ length: this.dimensions }).fill(0);
		const tokens = text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
		for (const token of tokens) {
			const hash = hashToken(token);
			const index = hash % this.dimensions;
			vector[index] = (vector[index] ?? 0) + ((hash & 1) === 0 ? 1 : -1);
		}
		return vector;
	}
}

export class ToolIndex {
	private constructor(
		private readonly embedder: TextEmbedder,
		private readonly entries: readonly VectorEntry[],
	) {}

	static async build(tools: readonly ToolDefinition[], embedder: TextEmbedder = new HashingTextEmbedder()): Promise<ToolIndex> {
		const entries = await Promise.all(tools.map(async (tool): Promise<VectorEntry> => {
			const definition = normalizeToolDefinition(tool);
			return {
				name: definition.name,
				description: definition.description ?? "",
				declaration: compileToolSchema(tool),
				tool,
				vector: await embedder.embed(searchableText(tool)),
			};
		}));
		return new ToolIndex(embedder, entries);
	}

	async search(query: string, topK = 3): Promise<ToolSearchResult[]> {
		if (!Number.isInteger(topK) || topK < 1) throw new Error("topK must be a positive integer.");
		const queryVector = await this.embedder.embed(query);
		return this.entries
			.map(({ vector, ...entry }) => ({ ...entry, score: cosineSimilarity(queryVector, vector) }))
			.filter((entry) => entry.score > 0)
			.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
			.slice(0, topK);
	}

	/** Return only the declarations selected for the current query. */
	async declarationsFor(query: string, topK = 3): Promise<string> {
		return (await this.search(query, topK)).map((match) => match.declaration).join("\n\n");
	}
}
