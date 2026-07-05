# amp-autoresearch

An [Amp](https://ampcode.com) plugin that runs an autonomous optimization loop: the
agent edits code, runs a benchmark, records the result, auto-commits improvements,
auto-reverts regressions, and repeats until interrupted or capped.

A port of [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) to Amp's
plugin API, with the same `.auto/` session file format.

```
edit code → run_experiment → log_experiment → keep or revert → repeat
```

## Install

```sh
mise run install    # symlinks autoresearch.ts into ~/.config/amp/plugins/
```

Then restart Amp or run `plugins: reload` from the command palette. The symlink matters:
the browser dashboard asset (`assets/dashboard.html`) is resolved through the symlink
back to this checkout.

## Usage

From the command palette:

| Command | Does |
|---|---|
| `Autoresearch: Start` | Asks for a working directory and goal, then sends the kickoff message. Resumes automatically when `.auto/prompt.md` exists. |
| `Autoresearch: Stop` | Deactivates the current thread's session. |
| `Autoresearch: Status` | One-glance digest: runs, baseline, best, confidence. |
| `Autoresearch: Dashboard` | Opens the live browser dashboard (charts, run table, SSE updates). |
| `Autoresearch: Clear log` | Deletes `.auto/log.jsonl` and deactivates. Kept commits stay in git. |

The agent then sets up the session itself: creates a branch, writes `.auto/prompt.md`
(the session playbook) and `.auto/measure.sh` (the benchmark), takes a baseline, and
loops. After every turn that logged an experiment, the plugin automatically sends
"run the next iteration" — capped at 20 auto-resumes by default (see config below);
any real message from you resets the cap.

### Headless (execute mode)

`amp -x` sessions have no UI, so confirmation dialogs fail closed and the loop won't
start. Opt in explicitly for unattended runs:

```sh
AMP_AUTORESEARCH_ASSUME_YES=1 amp -x "Set up and run an autoresearch loop: <goal> in $(pwd)…"
```

## Session files (`.auto/`)

Byte-compatible with pi-autoresearch (current layout; no legacy flat files).

| File | Purpose |
|---|---|
| `prompt.md` | Session playbook — objective, metrics, files in scope, constraints, what's been tried |
| `measure.sh` | Benchmark script; prints `METRIC name=value` lines |
| `log.jsonl` | Append-only run log (source of truth; written by the tools) |
| `checks.sh` | Optional correctness backpressure — runs after every passing benchmark; failing checks block `keep` |
| `ideas.md` | Optional ideas backlog |
| `config.json` | Optional session config (below) |
| `hooks/before.sh`, `hooks/after.sh` | Optional lifecycle hooks: JSON payload on stdin, stdout is fed back to the agent |
| `amp-session.json` | Amp-only: session/lock record binding the workdir to one thread |

Gitignore `log.jsonl` and `amp-session.json` (the kickoff prompt instructs the agent to
do this); commit `prompt.md` and `measure.sh`.

### `config.json`

```json
{
  "maxIterations": 50,
  "maxAutoResumeTurns": 100,
  "workingDir": "/path/to/project"
}
```

- `maxIterations` — stop the loop after this many experiments (pi-compatible).
- `maxAutoResumeTurns` — auto-resume cap per user interaction, default 20 (Amp-only;
  raise for overnight runs).
- `workingDir` — redirect all session I/O and git operations (pi-compatible).

## Tools

| Tool | Does |
|---|---|
| `init_experiment` | Binds a session to the thread. Takes `working_dir` (Amp exposes no cwd to plugins), name, metric, direction. Validates the git repo, refuses dirty worktrees, confirms takeovers and first activations. |
| `run_experiment` | Runs `.auto/measure.sh` (only — see safety), times it, parses `METRIC` lines, runs `checks.sh`, truncates output. |
| `log_experiment` | Appends to `log.jsonl`; `keep` → `git add -A && git commit`; anything else → revert everything except `.auto/`. Computes a MAD-based confidence score. |

## Safety model

- **Plugin tools run without Amp's command-approval prompts.** That is why
  `run_experiment` executes only `.auto/measure.sh` (plus `checks.sh` and hooks) —
  repo-local scripts the agent must author through normal, reviewable edits — and
  never an arbitrary command string. Treat starting a session in a repo as consenting
  to its `.auto/` scripts running.
- `init_experiment` hard-refuses dirty worktrees: discards run `git checkout -- .` and
  `git clean -fd` (excluding `.auto/`), which destroy uncommitted work.
- One active session per working directory (`.auto/amp-session.json` is the lock);
  one experiment in flight at a time; takeover requires confirmation.
- Auto-resume never overrides a cancelled or errored turn, and stops when the session's
  on-disk log disappears (e.g. after a branch switch).
- Cancelling a turn does **not** instantly kill an in-flight benchmark — Amp gives
  plugin tools no abort signal. The plugin polls thread state where available and
  always enforces the benchmark timeout (default 600s).

## Differences from pi-autoresearch

| pi | amp-autoresearch |
|---|---|
| `ctx.cwd` from host | explicit `working_dir` on `init_experiment` |
| `run_experiment` accepts arbitrary commands | always runs `.auto/measure.sh` only |
| tools gated via `setActiveTools` | tools always registered; gate on initialized session |
| timer-based auto-resume | native `agent.end → continue` |
| compaction hooks + deterministic summary | state digest embedded in every resume message |
| auto-activates on `.auto/log.jsonl` presence | only the recorded thread reactivates (`amp-session.json`) |
| TUI widget + fullscreen overlay | status item + browser dashboard |
| hook stdout → steer messages | hook stdout → tool results |
| legacy flat `autoresearch.*` files | not supported |

## Development

```sh
mise run check      # bun test + tsc --noEmit
mise run test
mise run typecheck
mise run fmt        # prettier
```

Design/plan: [docs/plans/amp-autoresearch.md](docs/plans/amp-autoresearch.md).
