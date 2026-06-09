<!--
This repo is maintained with AI-assisted review (see CONTRIBUTING.md). Your PR is judged from the
diff + this description + your evidence — so please fill every section. Small, focused, well-evidenced
PRs merge fast.
-->

## Summary
<!-- What does this change? One focused thing. -->

## Why
<!-- The problem it solves / motivation. Link the issue: Closes #__ -->
Closes #

## How verified
<!-- REQUIRED. Paste test output / repro steps / before-after numbers. Assume the reviewer won't run your branch. -->

## Risk / blast radius
<!-- What could this break? Anything reviewers should check carefully? -->

## Checklist
- [ ] Single, focused change (no unrelated refactors)
- [ ] Docs updated in this PR (README / README.ko config tables, command/tool lists, Changelog)
- [ ] Version bumped if the change must reach installed clients
- [ ] **No proprietary data or secrets** — incl. commit messages (no real paths, class/symbol names, company/project identifiers, tokens, or log contents)
- [ ] Generic / reusable (nothing tied to one company or project)
- [ ] `node --check` passes on changed JS; `claude plugin validate` clean
