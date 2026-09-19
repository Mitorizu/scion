# How to measure what Scion saves

This benchmark records the request Pi builds under each Scion setting and prints the size of each part. It calls no model. Nothing leaves your machine.

## Run it

```bash
bash bench/run.sh
```

The script prints one row per setting:

```
capture                  request     tools   n   catalog
observe                    13453      8062  18      2005
mask-skills                11946      8062  18       528
mask-skills-and-tools       8145      4261   7       528
```

Sizes are characters of JSON. `n` is the number of tool schemas in the request. Divide by four for a rough token count.

To measure a different prompt, pass it as an argument:

```bash
bash bench/run.sh "Draft release notes for the last milestone"
```

If port 8788 is busy, set `SCION_BENCH_PORT`.

## What the fixture contains

`bench/fixture/` holds eight skills and fourteen tools that stand in for a working setup. The skills declare dependencies, domain triggers, and `allowed-tools`. The tools carry descriptions and schemas sized like real ones.

The run uses `--no-extensions` and `--no-skills`, so your installed extensions and skills do not affect the result. That is what makes the numbers the same on any machine.

## Measure your own setup instead

Drop the two isolation flags to see what Scion does for the skills and tools you actually have:

1. Copy `bench/run.sh`.
2. Remove `--no-extensions` and `--no-skills` from the `pi` command.
3. Remove the two `-e` fixture arguments and point `--skill` at your own skills.

Your savings scale with how many tools your extensions register and how few of them a turn needs.

## Inspect one capture

`bench/report.mjs` prints the tool names when given a single file:

```bash
node bench/report.mjs /path/to/capture.json
```
