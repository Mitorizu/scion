export type JsonSchema = Record<string, unknown>;

export interface JsonToolDefinition {
	name: string;
	description?: string;
	parameters?: JsonSchema;
	inputSchema?: JsonSchema;
}

export interface OpenAiToolDefinition {
	type: "function";
	function: JsonToolDefinition;
}

export type ToolDefinition = JsonToolDefinition | OpenAiToolDefinition;

export interface CompileToolOptions {
	interfaceName?: string;
	export?: boolean;
}

interface CompileContext {
	root: JsonSchema;
	seenRefs: Set<string>;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;
const MAX_SCHEMA_DEPTH = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpenAiToolDefinition(tool: ToolDefinition): tool is OpenAiToolDefinition {
	return "type" in tool && tool.type === "function" && "function" in tool;
}

export function normalizeToolDefinition(tool: ToolDefinition): JsonToolDefinition {
	return isOpenAiToolDefinition(tool) ? tool.function : tool;
}

function parseJsonToolDefinition(value: unknown): JsonToolDefinition {
	if (!isRecord(value)) throw new Error("Tool definition must be a JSON object.");
	if (typeof value.name !== "string" || value.name.trim() === "") {
		throw new Error("Tool definition must have a non-empty name.");
	}
	if (value.description !== undefined && typeof value.description !== "string") {
		throw new Error("Tool description must be a string.");
	}
	if (value.parameters !== undefined && !isRecord(value.parameters)) {
		throw new Error("Tool parameters must be a JSON object.");
	}
	if (value.inputSchema !== undefined && !isRecord(value.inputSchema)) {
		throw new Error("Tool inputSchema must be a JSON object.");
	}
	return {
		name: value.name,
		...(typeof value.description === "string" ? { description: value.description } : {}),
		...(isRecord(value.parameters) ? { parameters: value.parameters } : {}),
		...(isRecord(value.inputSchema) ? { inputSchema: value.inputSchema } : {}),
	};
}

/** Parse an OpenAI-style or direct JSON tool definition at the input boundary. */
export function parseToolDefinition(value: unknown): ToolDefinition {
	if (isRecord(value) && value.type === "function") {
		if (!("function" in value)) throw new Error("OpenAI function tool must have a function definition.");
		return { type: "function", function: parseJsonToolDefinition(value.function) };
	}
	return parseJsonToolDefinition(value);
}

function pascalCase(value: string): string {
	const words = value.split(/[^A-Za-z0-9]+/u).filter(Boolean);
	const joined = words.map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`).join("");
	const safe = joined || "Tool";
	return /^[A-Za-z_$]/u.test(safe) ? safe : `Tool${safe}`;
}

function propertyName(value: string): string {
	return IDENTIFIER.test(value) ? value : JSON.stringify(value);
}

function stringLiteral(value: string): string {
	return `'${value
		.replaceAll("\\", "\\\\")
		.replaceAll("'", "\\'")
		.replaceAll("\r", "\\r")
		.replaceAll("\n", "\\n")}'`;
}

function literal(value: unknown): string {
	if (typeof value === "string") return stringLiteral(value);
	if (typeof value === "number" || typeof value === "boolean" || value === null) return JSON.stringify(value);
	return "unknown";
}

function jsDoc(description: unknown, indentation = ""): string[] {
	if (typeof description !== "string" || description.trim() === "") return [];
	const text = description.trim().replaceAll("*/", "*\\/");
	if (!text.includes("\n")) return [`${indentation}/** ${text} */`];
	return [
		`${indentation}/**`,
		...text.split(/\r?\n/u).map((line) => `${indentation} * ${line}`),
		`${indentation} */`,
	];
}

function localReference(root: JsonSchema, reference: string): JsonSchema | undefined {
	if (!reference.startsWith("#/")) return undefined;
	let current: unknown = root;
	for (const encodedPart of reference.slice(2).split("/")) {
		if (!isRecord(current)) return undefined;
		const part = encodedPart.replaceAll("~1", "/").replaceAll("~0", "~");
		current = current[part];
	}
	return isRecord(current) ? current : undefined;
}

function union(parts: readonly string[]): string {
	const unique = [...new Set(parts)];
	return unique.length === 0 ? "unknown" : unique.join(" | ");
}

function compileObject(schema: JsonSchema, context: CompileContext, depth: number): string {
	const properties = isRecord(schema.properties) ? schema.properties : {};
	const required = new Set(Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === "string") : []);
	const lines: string[] = ["{"];
	for (const [name, rawProperty] of Object.entries(properties)) {
		const property = isRecord(rawProperty) ? rawProperty : {};
		lines.push(...jsDoc(property.description, "  "));
		const type = compileSchemaType(property, context, depth + 1).replaceAll("\n", "\n  ");
		lines.push(`  ${propertyName(name)}${required.has(name) ? "" : "?"}: ${type};`);
	}
	if (schema.additionalProperties === true) lines.push("  [key: string]: unknown;");
	else if (isRecord(schema.additionalProperties)) {
		const type = compileSchemaType(schema.additionalProperties, context, depth + 1).replaceAll("\n", "\n  ");
		lines.push(`  [key: string]: ${type};`);
	}
	lines.push("}");
	return lines.join("\n");
}

function compileSchemaType(schema: JsonSchema, context: CompileContext, depth: number): string {
	if (depth > MAX_SCHEMA_DEPTH) return "unknown";
	if (typeof schema.$ref === "string") {
		if (context.seenRefs.has(schema.$ref)) return "unknown";
		const target = localReference(context.root, schema.$ref);
		if (!target) return "unknown";
		context.seenRefs.add(schema.$ref);
		const result = compileSchemaType(target, context, depth + 1);
		context.seenRefs.delete(schema.$ref);
		return result;
	}
	if (schema.const !== undefined) return literal(schema.const);
	if (Array.isArray(schema.enum) && schema.enum.length > 0) return union(schema.enum.map(literal));

	const alternatives = Array.isArray(schema.oneOf)
		? schema.oneOf
		: Array.isArray(schema.anyOf)
			? schema.anyOf
			: undefined;
	if (alternatives) {
		return union(alternatives.map((entry) => compileSchemaType(isRecord(entry) ? entry : {}, context, depth + 1)));
	}

	const declaredTypes = Array.isArray(schema.type)
		? schema.type.filter((value): value is string => typeof value === "string")
		: typeof schema.type === "string"
			? [schema.type]
			: [];
	if (declaredTypes.length > 1) {
		return union(declaredTypes.map((type) => compileSchemaType({ ...schema, type }, context, depth + 1)));
	}

	const type = declaredTypes[0] ?? (schema.properties ? "object" : undefined);
	switch (type) {
		case "string": return "string";
		case "integer":
		case "number": return "number";
		case "boolean": return "boolean";
		case "null": return "null";
		case "array": {
			const item = compileSchemaType(isRecord(schema.items) ? schema.items : {}, context, depth + 1);
			return item.includes(" | ") ? `Array<${item}>` : `${item}[]`;
		}
		case "object": return compileObject(schema, context, depth);
		default: return "unknown";
	}
}

/** Compile one JSON function schema into a compact TypeScript input interface. */
export function compileToolSchema(tool: ToolDefinition, options: CompileToolOptions = {}): string {
	const definition = normalizeToolDefinition(tool);
	const schema = definition.parameters ?? definition.inputSchema ?? { type: "object", properties: {} };
	const interfaceName = options.interfaceName ?? `${pascalCase(definition.name)}Input`;
	const lines = jsDoc(definition.description ?? schema.description);
	const type = compileSchemaType(schema, { root: schema, seenRefs: new Set() }, 0);
	const prefix = options.export === false ? "" : "export ";
	if (type.startsWith("{")) lines.push(`${prefix}interface ${interfaceName} ${type}`);
	else lines.push(`${prefix}type ${interfaceName} = ${type};`);
	return lines.join("\n");
}

/** Parse JSON and compile one function schema into a compact TypeScript declaration. */
export function compileToolSchemaJson(source: string, options: CompileToolOptions = {}): string {
	return compileToolSchema(parseToolDefinition(JSON.parse(source)), options);
}

/** Compile a registry into one TypeScript declaration block. */
export function compileToolRegistry(tools: readonly ToolDefinition[]): string {
	return tools.map((tool) => compileToolSchema(tool)).join("\n\n");
}
