# Demo

A scripted, **fully synthetic** terminal demo of `gamedev-log-analyzer` (no real project data). It
generates a UE-style log and runs `summary` / `search` / `locate` / `diff`, showing the token win.

## Run it

```bash
FAST=1 bash demo/play.sh    # quick, no typing animation
bash demo/play.sh           # full pace, good for recording
```

It runs in a throwaway temp dir with neutral filenames, so nothing on your machine leaks into a
recording — the tool prints `Source: Editor.log`, never a real path.

## Record → GIF / SVG

Needs [asciinema](https://asciinema.org) plus a converter
([agg](https://github.com/asciinema/agg) for GIF or
[svg-term-cli](https://github.com/marionebl/svg-term-cli) for SVG).

```bash
asciinema rec demo/demo.cast --overwrite -c "bash demo/play.sh"
agg demo/demo.cast demo/demo.gif                              # GIF
# or: svg-term --in demo/demo.cast --out demo/demo.svg --window  # SVG (crisper, smaller)
```

## Embed in the README

After committing `demo/demo.gif` (or `.svg`), drop this near the top of `README.md`:

```markdown
![gamedev-log-analyzer demo](demo/demo.gif)
```

Keep the recording short (~30 s) and the terminal ~90×24 so the GIF stays small. The `.cast` is the
source of truth — re-render to GIF/SVG anytime without re-recording.
