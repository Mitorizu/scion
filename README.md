# Scion

Scion is a [Pi](https://github.com/earendil-works/pi) extension that routes skills into the system prompt instead of listing all of them on every turn.

Pi puts every skill's name, description, and file path in the system prompt. That cost grows with each skill you install, and it is paid on every model request whether the skill is relevant or not. Scion ranks the catalog before each agent run and, in `mask` mode, exposes at most five matching skills. The model still loads a selected skill's full `SKILL.md` through Pi's normal progressive-disclosure path, so nothing is lost when the router is right.

Scion starts in `observe` mode. Observe records routing decisions and changes nothing, so you can watch what it would have selected before you let it edit the prompt.

## Install

```bash
pi install npm:@mitorizu/scion
```

Or from a checkout:

```bash
pi install git:github.com/Mitorizu/scion
```

Then enable masking in a trusted project by creating `.pi/scion.json`:

```json
{
  "mode": "mask"
}
```

Scion reads the setting before each agent run. It replaces only Pi's generated skill catalog. Skill files and explicit `/skill:name` commands remain available. If no skill matches, the automatic catalog is empty.

To return to observation without prompt changes, delete the file or set `mode` to `observe`. Scion ignores project configuration until Pi trusts the project.

## Configure a skill

Add routing metadata under the standard `metadata` frontmatter field:

```yaml
---
name: rust-review
description: Review Rust ownership, lifetime, and concurrency defects.
allowed-tools: rust_analyzer
metadata:
  depends_on:
    - systems-review
  domain_trigger:
    - '\.rs$'
    - match: Cargo.toml
---
```

The fields have these meanings:

- `depends_on` names skills that Scion must select with this skill.
- `domain_trigger` matches paths from the prompt, Git status, and Pi's file edits.
- `allowed-tools` is the Agent Skills field for a space-delimited list of tool names.

A domain trigger can be a JavaScript regular expression, `{ regex: 'pattern' }`, or `{ match: 'literal text' }`. Scion rejects invalid regular expressions, expressions longer than 256 characters, and expressions flagged as unsafe.

When `mask` mode selects a skill, Scion activates the tools in `allowed-tools` for that skill and its dependencies. This also works for a manual `/skill:name` invocation. Activation is additive for the session. Scion does not register linked tools or deactivate tools owned by another extension. `/scion:status` reports resolved links, and `/scion:explain` reports linked names that are not registered.

Use stable registered names such as `read` or `bash`. A generated MCP proxy name is not stable enough for skill metadata. Link the stable discovery tool instead. Linked tools should carry their instructions in the tool description rather than active-only prompt snippets.

Invalid metadata disables the affected skill. Missing dependencies, dependency cycles, and dependency closures larger than five also disable the affected skill. Skills without metadata remain eligible for prompt keyword matching.

## Inspect and rebuild

Scion shows `waiting for first prompt` at session start. After routing begins, the footer shows the mode, skill and tool sync state, estimated savings per model request, and estimated savings for the session.

A skill graph is synced when it has no disabled skills or metadata diagnostics. Tool links are synced when every `allowed-tools` name resolves to a tool registered with Pi.

Run `/scion:status` for counts, timing, selected skills, linked tools, and savings. Run `/scion:explain` for the same status plus selection reasons, changed paths, unavailable tools, and graph diagnostics.

Scion ranks skills from:

- an explicit skill name in the prompt;
- a matching domain trigger;
- an uncommon word from the skill name or description;
- a dependency of another selected skill.

Run `/scion:reindex` to delete the metadata cache and rebuild the graph. Scion otherwise invalidates cached metadata when a skill path, description, timestamp, or size changes. Cache files live under `~/.cache/scion/`, use mode `0600`, and do not contain skill bodies.

## Compile and search tool schemas

Scion also ships the tool-schema utilities it was built alongside. `compileToolSchema` converts direct or OpenAI-style JSON tool definitions to compact TypeScript declarations. It preserves descriptions as JSDoc, marks fields outside the JSON Schema `required` array as optional, converts enums to literal unions, and handles nested objects recursively.

```ts
import { compileToolSchemaJson, parseToolDefinition, ToolIndex } from "@mitorizu/scion";

const rawTool = JSON.stringify({
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
				sky: {
					type: "string",
					enum: ["clear", "rain"],
					description: "Sky condition to match.",
				},
			},
			required: ["location"],
		},
	},
});

console.log(compileToolSchemaJson(rawTool));

const tool = parseToolDefinition(JSON.parse(rawTool));
const index = await ToolIndex.build([tool]);
const promptTools = await index.declarationsFor("Will it rain in Paris?", 1);
```

The compiler prints:

```ts
/** Get the weather forecast for a location. */
export interface WeatherLookupInput {
  /** City and country to inspect. */
  location: string;
  /** Sky condition to match. */
  sky?: 'clear' | 'rain';
}
```

`ToolIndex` embeds each tool once and ranks queries with cosine similarity. Its default `HashingTextEmbedder` is a dependency-free lexical baseline. Pass a model-backed `TextEmbedder` for semantic matching. These utilities do not register tools with Pi. A skill's `allowed-tools` field links to tools after their owners register them.

## Performance and limits

Skill routing is synchronous and local. A unit test routes 500 skills in less than 50 ms. Git status collection has a 35 ms timeout and falls back to paths changed through Pi's `edit` and `write` tools.

Skill-to-tool links are exact names, so they add no embedding request. Linked tools remain active for the session after Scion adds them. This avoids taking tools away from other extensions, but it does not enforce a fixed tool-schema budget across a long session.

Token savings are estimates based on characters removed from the generated skill catalog. The per-request value applies to each model turn in the current agent run. The session value includes follow-up turns after tool calls.

The router is lexical, not semantic. It matches names, paths, and uncommon words. A prompt that describes a task without naming it or touching a matching path selects nothing, and `mask` mode then shows an empty catalog. Start in `observe` mode and read `/scion:explain` before you trust it with a large skill set.

## Develop

```bash
npm ci
npm run typecheck
npm test
```

Node 22.19 or newer. Scion imports `@earendil-works/pi-coding-agent` as a peer dependency because Pi provides it at runtime.

## License

MIT. See [LICENSE](LICENSE).
