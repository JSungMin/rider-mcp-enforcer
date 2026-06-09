#!/usr/bin/env bash
# Scripted terminal demo for asciinema. Uses a SYNTHETIC log — no real project data, and it runs in a
# throwaway temp dir with neutral filenames so a recording never shows a real path.
#
#   Record:   asciinema rec demo/demo.cast --overwrite -c "bash demo/play.sh"
#   To GIF:   agg demo/demo.cast demo/demo.gif          # github.com/asciinema/agg
#   To SVG:   svg-term --in demo/demo.cast --out demo/demo.svg --window
#   Fast (no typing animation, for a quick check):  FAST=1 bash demo/play.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/gamedev-log-analyzer/server/cli.js"
GEN="$ROOT/demo/gen-log.mjs"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK" # neutral cwd: the tool prints "Source: Editor.log", never a real path

FAST="${FAST:-0}"
nap() { [ "$FAST" = "1" ] || sleep "$1"; }
# Print a green prompt and "type" the command, then a beat.
p() {
  printf '\033[1;32m$\033[0m '
  if [ "$FAST" = "1" ]; then printf '%s\n' "$1"; else
    printf '%s' "$1" | while IFS= read -r -n1 c; do printf '%s' "$c"; sleep 0.018; done
    printf '\n'
  fi
  nap 0.4
}
say() { printf '\033[2;37m%s\033[0m\n' "$1"; nap 0.5; }

clear 2>/dev/null || true
say "# gamedev-log-analyzer — read a huge engine log for ~hundreds of tokens, not hundreds of thousands"
nap 0.4

p "node gen-log.mjs 6000 > Editor.log    # synthetic UE-style log"
node "$GEN" 6000 > Editor.log
BYTES=$(wc -c < Editor.log); LINES=$(wc -l < Editor.log)
say "  ${LINES} lines, ${BYTES} bytes  (~$((BYTES / 4)) tokens if you paste it raw)"
nap 0.7

p "gamedev-log summary --path Editor.log"
node "$CLI" summary --path Editor.log
SUM=$(node "$CLI" summary --path Editor.log | wc -c)
say "  ~$((SUM / 4)) tokens — severity counts + top categories, no message bodies."
nap 1.0

p "gamedev-log search --path Editor.log --severityMin Error --groupBy callsite"
node "$CLI" search --path Editor.log --severityMin Error --groupBy callsite --maxGroups 8
nap 1.0

p "gamedev-log locate --path Editor.log --severityMin Error --max 6   # jump list"
node "$CLI" locate --path Editor.log --severityMin Error --max 6
nap 1.0

node "$GEN" 6000 7 > Editor-prev.log
p "gamedev-log diff --pathA Editor-prev.log --pathB Editor.log   # what changed between runs"
node "$CLI" diff --pathA Editor-prev.log --pathB Editor.log --severityMin Warning || true
nap 1.2

say "# Same engine via MCP in Claude Code, or via npx without an IDE:"
p "npx -p gamedev-log-analyzer gamedev-log summary --path Editor.log"
nap 1.5
