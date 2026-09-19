#!/usr/bin/env bash
# Measure what Pi sends under each Scion setting.
#
# Runs three agent turns against a local capture server. No model is called and
# no request leaves the machine. Prints one row per setting.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
port="${SCION_BENCH_PORT:-8788}"
prompt="${1:-Review the ownership changes in src/lib.rs}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/.pi" "$work/src"
echo 'fn main() {}' > "$work/src/lib.rs"
git -C "$work" init -q .
git -C "$work" add -A

capture() {
	local label="$1" config="$2"
	printf '%s\n' "$config" > "$work/.pi/scion.json"
	node "$root/bench/capture.mjs" "$work/$label.json" "$port" > /dev/null &
	local server=$!
	sleep 1
	PI_OFFLINE=1 pi -a --no-session --no-extensions --no-skills \
		-e "$root/bench/fixture/extension.ts" \
		-e "$root" \
		--skill "$root/bench/fixture/skills" \
		--provider anthropic --model claude-haiku-4-5 --api-key bench \
		-p "$prompt" > /dev/null 2>&1 || true
	kill "$server" 2>/dev/null || true
	wait "$server" 2>/dev/null || true
}

cd "$work"
capture observe '{"mode":"observe"}'
capture mask-skills '{"mode":"mask","tools":"all"}'
capture mask-skills-and-tools '{"mode":"mask","tools":"linked"}'

node "$root/bench/report.mjs" "$work/observe.json" "$work/mask-skills.json" "$work/mask-skills-and-tools.json"
