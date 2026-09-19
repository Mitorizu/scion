import { describe, expect, it } from "vitest";
import {
	compileToolSchemaJson,
	parseToolDefinition,
	type ToolDefinition,
} from "../src/tool-compiler.js";
import { HashingTextEmbedder, ToolIndex } from "../src/tool-index.js";

const rawWeatherTool = JSON.stringify({
	type: "function",
	function: {
		name: "weather_lookup",
		description: "Get the weather forecast for a location.",
		parameters: {
			type: "object",
			properties: {
				location: {
					type: "string",
					description: "City and country to inspect.",
				},
				conditions: {
					type: "object",
					description: "Forecast filters.",
					properties: {
						sky: {
							type: "string",
							enum: ["clear", "rain"],
							description: "Sky condition to match.",
						},
						units: {
							type: "string",
							enum: ["celsius", "fahrenheit"],
							description: "Temperature units.",
						},
					},
					required: ["sky"],
				},
			},
			required: ["location"],
		},
	},
});

describe("tool schema compiler", () => {
	it("parses raw JSON and compiles nested descriptions and enums", () => {
		expect(compileToolSchemaJson(rawWeatherTool)).toBe(`/** Get the weather forecast for a location. */
export interface WeatherLookupInput {
  /** City and country to inspect. */
  location: string;
  /** Forecast filters. */
  conditions?: {
    /** Sky condition to match. */
    sky: 'clear' | 'rain';
    /** Temperature units. */
    units?: 'celsius' | 'fahrenheit';
  };
}`);
	});

	it("rejects malformed definitions at the JSON boundary", () => {
		expect(() => parseToolDefinition({ description: "Missing a name." })).toThrow("non-empty name");
		expect(() => compileToolSchemaJson("not JSON")).toThrow(SyntaxError);
	});
});

describe("tool schema index", () => {
	it("returns only the top matching declaration for prompt injection", async () => {
		const tools: ToolDefinition[] = [
			parseToolDefinition(JSON.parse(rawWeatherTool)),
			{
				name: "send_email",
				description: "Send an email message to a recipient.",
				parameters: {
					type: "object",
					properties: { recipient: { type: "string", description: "Email recipient." } },
					required: ["recipient"],
				},
			},
		];
		const index = await ToolIndex.build(tools, new HashingTextEmbedder(128));

		const matches = await index.search("Will it rain in Paris?", 1);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.name).toBe("weather_lookup");
		expect(await index.declarationsFor("Will it rain in Paris?", 1)).toContain("interface WeatherLookupInput");
		expect(await index.declarationsFor("Will it rain in Paris?", 1)).not.toContain("interface SendEmailInput");
	});
});
