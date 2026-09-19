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

## Withhold tool schemas

The skill catalog is usually not where the money goes. In a measured run on a 15-skill, 18-tool setup, tool schemas were 53% of the request and the skill catalog was 20%. Masking skills alone leaves the larger half untouched.

Add a tool policy to withhold tool schemas the turn does not need:

```json
{
  "mode": "mask",
  "tools": "linked"
}
```

Under `linked`, a request carries Pi's built-in tools, the tools selected skills name in `allowed-tools`, and anything already activated this session. Everything else is withheld. The default is `all`, which keeps Scion's existing behavior of only ever adding linked tools.

Withheld tools are not gone. Scion registers `scion_find_tools`, and the model calls it to search what was withheld and activate the matches:

```
scion_find_tools({ query: "search GitHub issues", limit: 2 })
-> Activated 2 tool(s):
   - github_search_tools: Search GitHub Actions MCP method names and descriptions.
   - github_describe_tool: Show one GitHub Actions MCP method schema and make it callable.
```

The active set only grows within a session. Scion never takes back a tool it activated. That matters more than the extra tokens it costs: tool schemas sit at the front of the request, so churning them every turn would invalidate the provider's cached prefix and charge full price for the whole payload. Growing the set lets Pi use native deferred loading where the model supports it.

Two limits are worth knowing before you turn this on. A withheld tool costs the model a round trip to recover, so a turn that needs an unusual tool gets slower. And a skill that links six tools keeps all six the moment it is selected, so the savings depend on how tightly your skills scope their `allowed-tools`.

Built-in tools a user disabled stay disabled. Scion keeps built-ins only when Pi had them active.

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

Run `/scion:status` for counts, timing, selected skills, linked tools, the tool policy, and savings. Run `/scion:explain` for the same status plus withheld tools, selection reasons, changed paths, unavailable tools, and graph diagnostics.

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

`ToolIndex` embeds each tool once and ranks queries with cosine similarity. Its default `HashingTextEmbedder` is a dependency-free baseline; pass a model-backed `TextEmbedder` for semantic matching. This is the pluggable path, meant for callers who want to bring their own embedding model. Scion's own `scion_find_tools` does not use it, and instead ranks by inverse document frequency, which needs no model and behaves better on the small corpus of one session's withheld tools.

These utilities do not register tools with Pi. A skill's `allowed-tools` field links to tools after their owners register them.

## Measured savings

One prompt, one project, three settings, captured off the wire against a local endpoint that records what Pi actually sends. Eight project skills plus seven global ones, 18 registered tools.

| setting | request | tools | skill catalog |
|---|---|---|---|
| `observe` | 20,202 chars | 10,624 (18 tools) | 3,931 |
| `mask`, `tools: all` | 17,640 chars | 10,624 (18 tools) | 1,419 |
| `mask`, `tools: linked` | 15,132 chars | 8,116 (12 tools) | 1,419 |

Against `observe` that is roughly 640 tokens per request from masking skills and another 630 from withholding tools. Your numbers depend on how many tools your extensions register and how many of them any one turn needs.

The six withheld tools in that run were the ones no selected skill asked for. The twelve that stayed were four built-ins, the discovery tool, and seven tools the selected skills named.

## Performance and limits

Skill routing is synchronous and local. A unit test routes 500 skills in less than 50 ms. Git status collection has a 35 ms timeout and falls back to paths changed through Pi's `edit` and `write` tools.

Skill-to-tool links are exact names, so they add no embedding request. `scion_find_tools` ranks withheld tools by inverse document frequency over their names and descriptions, which is also local and adds no request. Rarity weighting is what stops a query for "search GitHub issues" from returning `grep` because both descriptions say "search".

Token savings are estimates. The skill figure counts characters removed from the generated catalog; the tool figure counts the schemas left out of the request. Both use four characters per token. The per-request value applies to each model turn in the current agent run, and the session value accumulates across follow-up turns after tool calls.

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
