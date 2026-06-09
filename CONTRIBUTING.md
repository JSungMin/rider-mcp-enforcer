# Contributing

Thanks for your interest! Issues and PRs are welcome — bug fixes, new log formats/engines, additional
Rider tool mappings, performance, and docs.

## How this project is maintained

This repository is maintained with **AI (Claude Code) assistance**. The maintainer does **not** do a
deep line-by-line manual read of every PR — review is AI-assisted, with a human giving final approval.

That changes what makes a PR mergeable. A PR is reviewed primarily from its **diff + description +
evidence**, so the clearer and more self-contained it is, the faster it merges. Opaque, sprawling, or
unverifiable PRs may be slow or declined.

## What makes a PR merge fast

1. **Open an issue first** for anything non-trivial, so the approach is agreed before you build.
2. **Keep it small and single-purpose.** One concern per PR. No drive-by refactors or unrelated
   reformatting mixed in — they make AI review unreliable.
3. **Describe it clearly** (use the PR template): *what* changed, *why*, *how you verified it*, and the
   *risk / blast radius*. Assume the reviewer will not run your branch — make correctness checkable from
   the description.
4. **Include evidence.** Paste test output, a repro, or before/after numbers. New behavior should come
   with a way to confirm it.
5. **Update docs in the same PR.** README / README.ko config tables, command/tool lists, and the
   `## Changelog`. Bump the plugin `version` if the change must reach installed clients.
6. **No proprietary data or secrets** — anywhere, **including commit messages**. No real file paths,
   class/symbol names, company/project identifiers, tokens, or log contents. Use placeholders and
   aggregate numbers. PRs containing such data will be closed and may need history scrubbing.
7. **Keep it generic and reusable.** This is a public, general-purpose plugin — nothing tied to one
   company or game. Keep the MCP servers dependency-light and preserve the token-efficiency goals.
8. **Match the existing style** and conventions you see in nearby code.

## Local checks before you push

- `node --check` your changed `.js`/`.mjs` files.
- `claude plugin validate` (manifest check the review also runs).
- For server changes: start the MCP server and confirm it lists tools (see the README for dev usage).
- Scan your diff **and** commit messages for any internal names before pushing.

## Review and merge

- Be responsive to review comments; small follow-up commits are fine.
- Final approval and merge are the maintainer's call. Merges are squash-merged; please keep your branch
  focused so the squashed history stays clean.

## License

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE). See also
the [Privacy Policy](PRIVACY.md) — these plugins collect no user data.
