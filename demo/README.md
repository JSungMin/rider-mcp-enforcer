# Demo

A scripted, **fully synthetic** demo of `gamedev-log-analyzer` (no real project data). It generates a
UE-style log and runs `summary` / `search` / `locate` / `diff`, showing the token win. The rendered
result is [`demo.svg`](demo.svg), embedded in the main README.

## Regenerate (no asciinema needed)

asciinema isn't available on Windows, so the cast is built directly with Node, then converted with a
cross-platform tool:

```bash
node demo/make-cast.mjs                                                      # -> demo/demo.cast
npx --yes svg-term-cli --in demo/demo.cast --out demo/demo.svg --window \
  --width 104 --height 32                                                    # -> demo/demo.svg
# GIF instead of SVG (needs the agg binary): agg demo/demo.cast demo/demo.gif
```

`make-cast.mjs` runs the demo in a temp dir with neutral filenames, so the recording shows
`Source: Editor.log`, never a real path. Re-render from the `.cast` anytime without re-recording.

## Watch it live in a terminal

```bash
FAST=1 bash demo/play.sh    # quick, no typing animation
bash demo/play.sh           # full pace
```

`play.sh` is the human-watchable version; `make-cast.mjs` is the same flow emitted as an asciinema v2
cast for rendering. If you do have asciinema (Linux/macOS/WSL), you can also record `play.sh` directly:
`asciinema rec demo/demo.cast --overwrite -c "bash demo/play.sh"`.
