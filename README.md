# Winnow

Winnow is a [Pi](https://github.com/earendil-works/pi) extension that shrinks every model request by sending only the skills and tools the current turn needs.

Pi lists every installed skill and every registered tool on every request. You pay for all of them whether the turn uses one or none, and the bill grows each time you install something. Winnow ranks both before the request goes out and leaves the rest behind.

## What it saves

On the benchmark in this repository, a request drops from 13,453 characters to 8,147. That is **39% smaller, about 1,300 tokens per request**, on every turn of every session.

| setting | request | tool schemas | skill catalog |
|---|---|---|---|
| `observe`, the default | 13,453 | 8,062 (18 tools) | 2,005 |
| `mask`, skills only | 11,946 | 8,062 (18 tools) | 528 |
| `mask`, skills and tools | **8,147** | **4,263 (7 tools)** | 528 |

Most of the win is tools, not skills. Tool schemas were 60% of that request and the skill catalog was 15%.

Run `bash bench/run.sh` to reproduce the table. It records what Pi sends to a local endpoint and calls no model. See [the benchmark guide](bench/README.md) for how to measure your own skills and tools instead.

Your numbers depend on how many tools your extensions register and how few of them a turn needs. Start in `observe` mode, which changes nothing, and watch what Winnow would have done.

## Install

```bash
pi install npm:@mitorizu/winnow
```

Or install from a checkout:

```bash
pi install git:github.com/Mitorizu/scion
```

Winnow starts in `observe` mode. It records routing decisions and changes no request.

## Turn it on

To mask the skill catalog, create `.pi/winnow.json` in a trusted project:

```json
{
  "mode": "mask"
}
```

Winnow now sends at most five matching skills instead of the whole catalog. The model still opens a selected skill's full `SKILL.md` through Pi's normal progressive disclosure, so a correctly routed skill loses nothing. Skill files and explicit `/skill:name` commands keep working. If no skill matches, the catalog is empty.

To withhold tool schemas as well, add a tool policy:

```json
{
  "mode": "mask",
  "tools": "linked"
}
```

Under `linked`, a request carries Pi's built-in tools, the tools that selected skills name in `allowed-tools`, and every tool already activated this session. Winnow withholds the rest. The default, `all`, keeps Winnow's older behavior of only ever adding linked tools.

Withheld tools are still reachable. Winnow registers `winnow_find_tools`, and the model calls it to search what was withheld and switch the matches on:

```
winnow_find_tools({ query: "find open pull requests in the issue tracker", limit: 2 })
-> Activated 2 tool(s):
   - issue_search: Search the issue tracker for issues and pull requests by keyword, label, author, or state.
   - issue_list_projects: List the projects and repositories the issue tracker credential can reach.
```

To go back to observing, delete the file or set `mode` to `observe`. Winnow ignores project configuration until Pi trusts the project.

## Configure a skill

Winnow reads routing metadata from the standard `metadata` frontmatter field:

```yaml
---
name: rust-review
description: Review Rust ownership, lifetime, and concurrency defects.
allowed-tools: code_search code_references
metadata:
  depends_on:
    - systems-review
  domain_trigger:
    - '\.rs$'
    - match: Cargo.toml
---
```

The fields mean this:

- `depends_on` names skills that Winnow must select together with this skill.
- `domain_trigger` matches paths from the prompt, from Git status, and from Pi's file edits.
- `allowed-tools` is the Agent Skills field for a space-delimited list of tool names.

Write a domain trigger as a JavaScript regular expression, as `{ regex: 'pattern' }`, or as `{ match: 'literal text' }`. Winnow rejects an invalid expression, an expression longer than 256 characters, and an expression its safety check flags.

Name tools by their stable registered names, such as `read` or `bash`. A generated MCP proxy name changes between runs, so link the stable discovery tool instead. Give a linked tool its instructions in the tool description rather than in an active-only prompt snippet.

Invalid metadata disables the affected skill. So do a missing dependency, a dependency cycle, and a dependency closure larger than five. A skill with no metadata stays eligible for keyword matching.

## Inspect what Winnow did

At session start the footer reads `waiting for first prompt`. After the first turn it shows the mode, whether skills and tools are in sync, how many tools Winnow withheld, and the estimated savings for the request and the session.

Skills are in sync when no skill is disabled and no metadata diagnostic fired. Tools are in sync when every `allowed-tools` name resolves to a tool Pi has registered.

Three commands report the detail:

- `/winnow:status` gives counts, timing, selected skills, linked tools, the tool policy, and savings.
- `/winnow:explain` adds withheld tools, the reason each skill was selected, changed paths, unavailable tools, and graph diagnostics.
- `/winnow:reindex` deletes the metadata cache and rebuilds the dependency graph.

Winnow otherwise rebuilds cached metadata when a skill's path, description, timestamp, or size changes. Cache files live under `~/.cache/winnow/`, use mode `0600`, and hold no skill bodies.

## How Winnow chooses

Winnow ranks a skill on four signals, in descending weight:

1. The prompt names the skill.
2. A domain trigger matches a changed path.
3. An uncommon word from the skill's name appears in the prompt.
4. An uncommon word from the skill's description appears in the prompt.

A selected skill brings its `depends_on` closure with it. Winnow fills up to five skills and stops.

For tools, the active set only grows within a session. Winnow never takes back a tool it activated, even when the next turn selects different skills. That costs some tokens and buys something worth more. Tool schemas sit at the front of a request, so replacing them every turn would invalidate the provider's cached prefix and charge full price for the whole payload. A set that only grows also lets Pi use native deferred loading on models that support it.

`winnow_find_tools` ranks withheld tools by inverse document frequency over their names and descriptions. Weighting by rarity is what keeps a query for "search GitHub issues" from returning `grep`, which matches only because both descriptions contain "search".

## Limits

The router is lexical, not semantic. It matches names, paths, and uncommon words. A prompt that describes a task without naming it and without touching a matching path selects nothing, and `mask` mode then sends an empty catalog.

A withheld tool costs the model one round trip to recover, so a turn that needs an unusual tool runs slower.

`winnow_find_tools` matches whole words and does not stem them. A query for "runbook" does not match a description that says "runbooks". Write tool descriptions with the words a caller would use.

A skill that links six tools keeps all six as soon as it is selected. Savings depend on how tightly your skills scope `allowed-tools`.

Winnow keeps a built-in tool only when Pi had it active, so a tool you disabled stays disabled.

Savings figures are estimates at four characters per token. The skill figure counts characters removed from the catalog. The tool figure counts the schemas left out of the request.

Skill routing is synchronous and local. A unit test routes 500 skills in under 50 ms. Reading Git status has a 35 ms timeout, after which Winnow falls back to the paths changed through Pi's `edit` and `write` tools.

## Compile and search tool schemas

Winnow also ships the tool-schema utilities it was built alongside. `compileToolSchema` turns a direct or OpenAI-style JSON tool definition into a compact TypeScript declaration. It keeps descriptions as JSDoc, marks any field outside the JSON Schema `required` array as optional, turns enums into literal unions, and recurses through nested objects.

```ts
import { compileToolSchemaJson, parseToolDefinition, ToolIndex } from "@mitorizu/winnow";

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

The compiler prints this:

```ts
/** Get the weather forecast for a location. */
export interface WeatherLookupInput {
  /** City and country to inspect. */
  location: string;
  /** Sky condition to match. */
  sky?: 'clear' | 'rain';
}
```

`ToolIndex` embeds each tool once and ranks queries by cosine similarity. Its default `HashingTextEmbedder` is a baseline with no dependencies. Pass a model-backed `TextEmbedder` for semantic matching. This is the path for callers who want to bring their own embedding model. Winnow's own `winnow_find_tools` does not use it, because inverse document frequency needs no model and ranks better on the small set of tools one session withholds.

These utilities register nothing with Pi. A skill's `allowed-tools` field links to a tool after its owner registers it.

## Develop

```bash
npm ci
npm run typecheck
npm test
```

Winnow needs Node 22.19 or newer. It imports `@earendil-works/pi-coding-agent` and `typebox` as peer dependencies, because Pi provides both at runtime.

## License

MIT. See [LICENSE](LICENSE).
