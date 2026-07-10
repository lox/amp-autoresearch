---
name: optimising-with-autoresearch
description: Launches amp-autoresearch to optimise a PR, branch, benchmark, or performance-sensitive change. Use when asked to run autoresearch, optimise or optimize this PR, make this faster, or do a performance pass.
---

# Optimising With Autoresearch

Use this skill to turn a performance-oriented request into an amp-autoresearch
session, rather than hand-rolling an optimisation loop in the current thread.

## Workflow

1. Confirm the request is performance/optimisation shaped: examples include
   "optimise this PR", "make this benchmark faster", "run autoresearch", or
   "do a performance pass".
2. If the target benchmark or metric is ambiguous, ask one short clarification.
   Otherwise proceed with a concise goal in the user's words.
3. Prefer launching in a new thread so the current PR/review thread remains usable.
4. Call the `start_autoresearch` tool with:
   - `goal`: one sentence describing what to improve.
   - `target`: `"new_thread"`.
   - `executor`: `"orb"` when the user asks to run remotely/in an orb; otherwise omit
     it for the local default.
   - `purpose`: `"pr_optimization"` when optimising an existing PR or branch.
   - `max_iterations`: usually `15` for PR polish, or `30` for broader exploration.
   - `working_dir`: only when the open workspace is not the repo to optimise.
5. Report the returned thread link and remind the user that the child thread owns the
   autoresearch loop. For an orb, also mention `amp sync <thread-id>`.

## Defaults

- For an end-of-PR optimisation pass, use `max_iterations: 15` unless the user asks
  for a longer grind.
- For a standalone benchmark exploration, use the plugin default unless the user gave
  a time/iteration budget.
- Before an orb launch, ensure the source commit is pushed. Orbs start from a fresh
  clone and cannot see local-only commits, uncommitted changes, or ignored `.auto/`
  session state. The repository must be the open Amp workspace because its project is
  what the orb clones. Continue an existing orb session in its original thread rather
  than creating a new orb to resume it.
- Do not run arbitrary benchmark commands through plugin tools. The autoresearch
  session will write `.auto/measure.sh`, then `run_experiment` will execute only that
  vetted script.

## When the launcher tool is unavailable

If `start_autoresearch` is not available, tell the user the amp-autoresearch plugin
needs to be installed/reloaded, then offer the manual fallback:

```sh
AMP_AUTORESEARCH_ASSUME_YES=1 amp -x "Set up and run an autoresearch loop: <goal> in $(pwd)…"
```

Do not simulate autoresearch manually in the current thread unless the user explicitly
asks for that fallback.
