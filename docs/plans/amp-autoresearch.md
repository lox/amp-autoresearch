# amp-autoresearch: Autonomous Experiment Loop Plugin for Amp

**Reference implementation:** [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) v1.6.1
**Plugin API reference:** `amp plugins show-docs` (also https://ampcode.com/manual/plugin-api)
**Status:** Proposed
**Last reviewed:** 2026-07-05

## Summary

An Amp plugin that runs an autonomous optimization loop: the agent edits code, runs a
benchmark, records the result, auto-commits improvements, auto-reverts regressions, and
repeats until interrupted or capped. The plugin is domain-agnostic infrastructure; each
session's `.auto/` directory carries the domain knowledge (what to optimize, how to
measure it, what's off limits).

The user experience: run `autoresearch: start` from the command palette, describe the
goal in an input dialog, and watch the loop run — scoreboards in the thread after every
experiment, a one-line status item near the prompt, and a live browser dashboard with
metric charts. The loop survives context compaction because all state lives on disk in
`.auto/`, not in the conversation.

The `.auto/` file format is byte-compatible with pi-autoresearch so sessions, tooling,
and dashboards can be shared across both agents.

## Background

### What pi-autoresearch does

pi-autoresearch is a Pi extension implementing "edit → run_experiment → log_experiment →
keep or revert → repeat". Its moving parts:

- **Three tools**: `init_experiment` (session config: name, metric, unit, direction),
  `run_experiment` (runs a command with timeout, parses `METRIC name=value` output lines,
  runs optional backpressure checks), `log_experiment` (appends to a JSONL log, commits
  on `keep`, reverts on `discard`/`crash`/`checks_failed`, computes a MAD-based
  confidence score).
- **Persistent state** in `.auto/`: `prompt.md` (session rules), `measure.sh`
  (benchmark), `log.jsonl` (append-only run log; source of truth), plus optional
  `checks.sh`, `ideas.md`, `config.json`, `hooks/before.sh`, `hooks/after.sh`.
- **Auto-resume**: after an agent turn that logged an experiment, send "Run the next
  iteration now" (capped at 20 auto-resume turns). After compaction, inject a
  deterministic summary built from `.auto/` files.
- **A create skill** that instructs the agent to gather goal/command/metric, create a
  branch, write `prompt.md` + `measure.sh`, take a baseline, and loop forever.
- **UI**: inline TUI widget, fullscreen dashboard overlay, and a local browser dashboard
  served over HTTP with SSE live updates.

### Why a port, not a wrapper

Pi and Amp have structurally similar but incompatible extension APIs (Amp's plugin API is
explicitly inspired by Pi's). The loop logic is directly translatable; the host
integration (events, tool registration, UI, lifecycle) must be rewritten. Amp also lacks
several Pi capabilities, which forces real design changes rather than mechanical
translation — see "Deviations from pi-autoresearch".

### Amp plugin API facts this design depends on

Verified against `amp plugins show-docs` (current version):

- Plugins are long-lived Bun processes serving **multiple threads concurrently**,
  loaded from `.amp/plugins/*.ts` (project) or `~/.config/amp/plugins/*.ts` (system).
- `amp.registerTool` — tools are always visible to the agent; there is **no tool
  gating** (no `setActiveTools` equivalent).
- `amp.registerCommand` — palette commands with dynamic availability
  (`setAvailability`); handlers get `ctx.thread?` and `ctx.ui`
  (`input`/`confirm`/`select`/`notify`).
- `agent.start` handler may return `{message: {content, display}}` — appended **inside**
  the user's message, after their content.
- `agent.end` handler receives `{status: 'done'|'error'|'cancelled', messages}` and may
  return `{action: 'continue', userMessage}` to start the next turn — this is the
  documented replacement for pi's timer-based resume.
- `amp.helpers.toolCallsInMessages(messages)` pairs tool calls with results — used to
  detect whether a turn logged an experiment.
- **No cwd/workspace-root API exists anywhere** (not on system, thread, or tool
  context). A system plugin may serve threads from many projects at once.
- **No compaction events** exist.
- **No abort signal** in tool `execute`; plugin must own subprocess lifecycle.
- `experimental.createStatusItem` — one-line text near the prompt editor with an
  optional click URL (`command:` URIs supported). Experimental API.
- `thread.messages()` is clamped to 20 messages — thread history cannot be a state
  store; `.auto/log.jsonl` is the source of truth.

## Goals

- Full experiment loop parity with pi-autoresearch: init/run/log tools, keep/revert git
  semantics, confidence scoring, checks backpressure, ideas backlog, hooks.
- `.auto/` file format compatibility with pi-autoresearch (current layout; no legacy
  flat-file support).
- Loop robustness across plugin reloads and context compaction via disk-persisted state.
- Safe multi-thread behavior: one active autoresearch session per working directory,
  enforced by a lock.
- v1 UI: per-run scoreboard in tool results, experimental status item, live browser
  dashboard (SSE), palette commands with dialogs.

## Non-goals

- **Legacy pi file layout** (flat `autoresearch.*` files) — current `.auto/` layout only.
- **Finalize-into-branches skill** (pi's `autoresearch-finalize`) — deferred; the
  kept-commit history is usable manually until then.
- **Custom agent mode** (`registerAgentMode`) as the system-prompt mechanism — deferred
  to v2; requires pinning a model and shipping mode metadata comments.
- **Terminal fullscreen dashboard / keyboard shortcuts** — no Amp API for either.
- **Streaming benchmark output during a run** — no partial tool output API.
- **npm packaging/distribution** — install is copy/symlink into `~/.config/amp/plugins/`.

## Target model

### User-facing lifecycle

```
palette: autoresearch: start
   │
   ▼ input dialog: "What should I optimize?"
   │
   ▼ kickoff user message appended to thread
   │   (create-skill prompt if no .auto/prompt.md, else resume instructions)
   │
   ▼ agent: gathers context → writes .auto/prompt.md + measure.sh → branch
   │   → init_experiment → baseline run → log_experiment
   │
   ╭──────────────── loop ────────────────╮
   │ agent edits code                     │
   │ run_experiment  → timed, METRIC parse│
   │ log_experiment  → jsonl, commit/rev  │
   │ agent.end → {action:'continue', …}   │◀── cap: 20 auto-resumes,
   ╰──────────────────────────────────────╯    reset by real user msg
   │
   ▼ palette: autoresearch: stop   (or cap reached, or user interrupts)
```

### Commands (palette)

| Command | Behavior |
|---|---|
| `autoresearch: start` | Input dialog for goal → validate worktree/lock → activate session → append kickoff message to current thread. Disabled with reason when another thread holds the workdir lock. |
| `autoresearch: stop` | Deactivate session, update session file, notify. Hidden when inactive. |
| `autoresearch: clear` | Confirm dialog → delete `.auto/log.jsonl`, reset state. Hidden when inactive. |
| `autoresearch: dashboard` | Start (or reuse) local HTTP dashboard server, open browser via `system.open`. |
| `autoresearch: status` | Notify with one-line summary (runs, best, confidence). |

### Tools

All three registered unconditionally. `run_experiment` and `log_experiment` gate on
**initialized session** (not "mode"): they error with "No experiment session for this
thread. Call init_experiment with the workspace root first." Manual one-off benchmarking
therefore works without the loop.

**`init_experiment`** — one deliberate deviation from pi: a required `working_dir`
parameter, because Amp exposes no cwd to plugins. The agent knows its workspace root;
the plugin validates it.

```jsonc
{
  "name": "init_experiment",
  "inputSchema": {
    "type": "object",
    "properties": {
      "working_dir": { "type": "string", "description": "Absolute path to the workspace root (must be a git repository)" },
      "name":        { "type": "string" },
      "metric_name": { "type": "string" },
      "metric_unit": { "type": "string" },   // optional, default ""
      "direction":   { "type": "string" }    // optional, "lower"|"higher", default "lower"
    },
    "required": ["working_dir", "name", "metric_name"]
  }
}
```

Behavior: validate `working_dir` (exists, `git rev-parse --show-toplevel` succeeds);
resolve effective workdir via `.auto/config.json` `workingDir` if present; **confirm the
resolved realpath with the user via `ctx.ui.confirm` on first activation** (an
agent-supplied path can be a wrong-but-valid repo — a dotfiles repo in `$HOME`, a
sibling project — and `git clean -fd` would later run there; refuse when UI is
unavailable); **hard-refuse on a dirty worktree** ("commit or stash first" — no
override: uncommitted tracked changes would be destroyed by `git checkout -- .` on the
first discard, untracked files by `git clean -fd`); refuse on the default branch unless
the user confirms (branch commits are recoverable, dirty state is not); acquire the
workdir lock (see Session persistence); append config header to `.auto/log.jsonl`; bind
the session to the thread.

**`run_experiment`** — `{timeout_seconds?, checks_timeout_seconds?}`. **Always requires
and only executes `.auto/measure.sh`** — a deliberate hardening over pi, which accepted
arbitrary commands until `measure.sh` existed. Plugin tools sidestep the approval
scrutiny users expect for Bash commands, so the executable surface is pinned to scripts
the agent must author through normal, reviewable edit tools first (the kickoff flow
writes `measure.sh` before the baseline run, so nothing breaks). Refuses with a pointer
to the kickoff flow when `measure.sh` is missing. Spawns via Bun with a plugin-owned
kill timer (default 600s) since Amp provides no abort signal; polls `thread.state`
during the run and kills the process group if the thread leaves `running` (turn
cancelled). A **per-workdir single-flight lock** rejects a second concurrent
`run_experiment` ("experiment already running, started Ns ago"). Parses
`METRIC name=value` lines. Runs `.auto/checks.sh` after a passing benchmark (default
300s timeout); checks duration excluded from the metric. Output truncated to last 10
lines / 4KB, full output saved to a temp file. Runs `.auto/hooks/before.sh` prior to the
benchmark; hook stdout is appended to the tool result (not sent as a steer message).

**`log_experiment`** — `{commit, metric, status: keep|discard|crash|checks_failed,
description, metrics?, force?, asi?}`. Order of operations: on `keep` run
`git add -A && git commit` first (commit message includes the result trailer), then
append the JSONL line carrying the **post-commit sha** — finalize-style workflows map
kept changes by that hash, so accuracy wins over including the log line in its own
commit. pi's stale-log-in-commit problem is solved instead by the kickoff prompt
gitignoring `.auto/log.jsonl` and `.auto/amp-session.json` (while `prompt.md` and
`measure.sh` stay committed). On non-keep, revert with pi's exact exclusion globs:

```bash
git checkout -- . ':(exclude,glob)**/.auto' ':(exclude,glob)**/.auto/**'
git clean -fd -e '.auto' -e '**/.auto/**'
```

Blocks `keep` when the last run's checks failed. Enforces secondary-metric consistency
(`force: true` to add new ones). Computes MAD-based confidence (port pi's
`computeConfidence` verbatim). Runs `.auto/hooks/after.sh`; stdout appended to result.
Renders the scoreboard (see UI). Aborts the loop when `maxIterations` from
`.auto/config.json` is reached.

### The loop: agent.end → continue

```ts
amp.on('agent.end', (event, ctx) => {
  const s = sessionForThread(event.thread.id)
  if (!s?.active) return
  if (event.status !== 'done') return            // never override cancel; never loop errors
  if (!turnLoggedExperiment(event.messages)) return  // via helpers.toolCallsInMessages:
                                                     // successful log_experiment call present
  if (s.autoResumeTurns >= maxAutoResumeTurns(s)) {  // default 20 (pi parity);
    notifyCapReached(ctx); return                    // .auto/config.json override
  }
  s.autoResumeTurns++
  persistSession(s)
  return { action: 'continue', userMessage: resumeMessage(s) }
})
```

- Gate on `log_experiment` (not `run_experiment`), matching pi: a chat-only or run-only
  turn must not resume, or the loop would spin on conversation.
- `autoResumeTurns` resets on a genuine user message. Detection is **structural**, not
  exact-match: a resume-originated turn is one whose opening message starts with the
  resume preamble and contains `<autoresearch-state>`. (Exact-matching against the
  last-sent message held in memory breaks across plugin reloads — the memory is gone,
  the next continue-turn is misclassified as user input, and the cap silently stops
  guarding.) Without any reset, the cap permanently bricks the loop after 20 iterations.
- The cap defaults to 20 (pi parity) and is overridable via `maxAutoResumeTurns` in
  `.auto/config.json` (Amp-only key, ignored by pi): one turn can hold many experiments,
  but unattended overnight runs would otherwise stop after 20 turns with only a
  notification nobody is awake to read.
- **Fail closed on stranded sessions**: if `.auto/log.jsonl` is missing when building a
  resume message or digest (e.g., the user checked out a branch without the committed
  `.auto/` files while `amp-session.json`, being untracked, still says `active`),
  deactivate the session and notify instead of looping blind.
- The resume message is self-contained: pi's resume text + anti-cheat guardrail + the
  state digest (below), so it works even if `agent.start` injection does not fire for
  continue-originated turns (undocumented; verified in Slice 0).

Resume message template:

```
Run the next iteration now. Use the persisted autoresearch state as needed, pick the
most promising hypothesis, then call run_experiment + log_experiment. Be careful not to
overfit to the benchmarks and do not cheat on the benchmarks.

<autoresearch-state>
{digest}
</autoresearch-state>
```

### Context injection and compaction survival

Amp has no compaction events, so the design assumes the conversation can be truncated at
any time. Compensation:

- Every resume message carries the digest (above).
- `agent.start` for user-originated turns (while a session is active) returns
  `{message: {content: '<autoresearch-state>…</autoresearch-state>', display: false}}` —
  digest only, clearly delimited since it is appended inside the user's message.
- Full loop rules are **not** repeated per turn (they would accumulate N copies in
  context); they live once in the kickoff message and in `.auto/prompt.md`, which the
  digest points at.

Digest format (~10 lines, built from `.auto/log.jsonl` + session state):

```
session: <name> | metric: <metric_name> (<unit>, lower is better)
runs: 14 (9 keep, 4 discard, 1 crash) | baseline: 5.60µs | best: 4.21µs (−24.8%) | confidence: 2.3×
rules: .auto/prompt.md (read if you have not this turn) | ideas: .auto/ideas.md
recent:
  #12 keep    4.35µs (−22.3%) | inline hot-path comparator
  #13 discard 4.52µs          | branchless variant — slower
  #14 keep    4.21µs (−24.8%) | hoist allocation out of loop
```

### Session persistence and the workdir lock

New design work Amp forces (pi had 1:1 session↔cwd; Amp threads don't):

`.auto/amp-session.json`, written in the workdir — doubles as restart-recovery record
and per-workdir lock:

```jsonc
{
  "version": 1,
  "threadID": "T-…",
  "workdir": "/canonical/realpath",
  "active": true,
  "autoResumeTurns": 3,
  "activatedAt": 1751688000000
}
```

Rules:

- **Reactivation**: on any event or tool call for thread T with no in-memory state,
  lazily load the session file for the bound workdir; reactivate only if
  `threadID === T && active`. A different thread never inherits the session — no silent
  reactivation for unrelated threads that happen to touch a repo with an old `.auto/`.
- **Lock**: `autoresearch: start` and `init_experiment` refuse when the file names a
  different thread with `active: true`; offer takeover via `ctx.ui.confirm`
  (refuse when UI unavailable). Workdirs compared by `realpath`.
- In-memory runtime (per-thread `Map<ThreadID, Runtime>`) holds only ephemera:
  `lastRunChecks`, last-sent resume message, experiment counters. Everything the loop
  needs to survive a reload is on disk (`amp-session.json` + `log.jsonl`).

### UI/UX surfaces

1. **Tool results — the in-thread scoreboard.** Every `log_experiment` result renders:
   run number, metric with delta vs. baseline and best, verdict, tallies, confidence,
   and a 3-row recent-runs table. `run_experiment` results show elapsed time, parsed
   metrics, checks status, truncated output tail.
2. **Status item (experimental API).** One line, updated after every log:
   `🔬 autoresearch · 14 runs · best 4.21µs (−25%) · conf 2.3×`. Click URL:
   `command:autoresearch-dashboard`.
3. **Browser dashboard.** Local Bun HTTP server on `127.0.0.1` (random port), serving:
   `/` (dashboard HTML adapted from pi's single-file `template.html`), `/log.jsonl`
   (live log), `/events` (SSE; `jsonl-updated` broadcast after every log). Charts of
   metric over time with baseline/best lines, run table with status colors, secondary
   metrics. One server per workdir; stopped on `stop` and plugin unload.
4. **Dialogs/notifications.** Input for goal; confirm for dirty worktree, lock takeover,
   clear. Notify on: session on/off, new best, cap reached, checks failing.

All `ctx.ui.*` calls wrapped with `helpers.isPluginUINotAvailableError` fallbacks
(non-interactive contexts refuse destructive paths, proceed with safe defaults).

### Kickoff prompt (port of pi's autoresearch-create skill)

Embedded in the plugin as a template string; appended as the kickoff user message when
no `.auto/prompt.md` exists. Contents (adapted from pi's SKILL.md):

1. Gather/infer: goal, benchmark command, metric + direction, files in scope, constraints.
2. `git checkout -b autoresearch/<goal>-<date>`.
3. Read source files; understand the workload before writing anything.
4. Write `.auto/prompt.md` (objective / metrics / how to run / files in scope /
   off limits / constraints / what's been tried) and `.auto/measure.sh` (emits
   `METRIC name=value` lines). Commit both.
5. `init_experiment` (with the workspace root as `working_dir`) → baseline
   `run_experiment` → `log_experiment` → loop.
6. Loop rules: primary metric is king; annotate runs with `asi`; watch confidence;
   simpler is better; don't thrash; log crashes and move on; append deferred ideas to
   `.auto/ideas.md`; never stop until interrupted.

When `.auto/prompt.md` exists, the kickoff message is instead: read `.auto/prompt.md`
and recent `log.jsonl`, then continue the loop.

## Deviations from pi-autoresearch

| pi | amp-autoresearch | Why |
|---|---|---|
| `ctx.cwd` from host | Required `working_dir` on `init_experiment` | Amp exposes no cwd; system plugins serve many projects per process |
| Tool gating via `setActiveTools` | Tools always registered; gate on initialized session | No gating API; also enables manual benchmarking |
| Timer-based resume (800ms settled window, idle checks) | `agent.end → {action:'continue'}` | Native Amp mechanism; the timer existed to dodge pi-internal races |
| Compaction events + deterministic summary | Digest in every resume message + `agent.start` injection | No compaction events in Amp |
| Auto-activate on `.auto/log.jsonl` existence (same cwd) | Reactivate only the recorded thread via `amp-session.json` | Amp threads aren't 1:1 with a cwd; silent reactivation would make unrelated threads loop and commit |
| Hook stdout → steer messages | Hook stdout → appended to tool result | Hooks run inside tool execution; the result is the natural channel |
| jsonl written after `git add -A` | jsonl written before commit | Fixes latent pi ordering bug (log line missing from keep commits) |
| `run_experiment` accepts arbitrary commands (until `measure.sh` exists) | Always requires and only executes `.auto/measure.sh` | Plugin tools sidestep Bash approval scrutiny; pin the executable surface to reviewably-authored scripts |
| No dirty-worktree guard in extension | Hard refusal on dirty worktree (no override); confirm-only for default branch; confirm resolved workdir at first activation | `git checkout -- .`/`git clean -fd` on user files is unrecoverable data loss; a wrong-but-valid `working_dir` would aim them at the wrong repo |
| `runningExperiment` tracked, host-mediated abort | Per-workdir single-flight lock + thread-state polling to kill orphaned benchmarks | Amp tools get no abort signal; cancel + resume could otherwise run two benchmarks concurrently |
| `/autoresearch <args>` slash command | Palette commands + input dialogs | Amp commands take no args |
| TUI widget + fullscreen overlay | Status item + browser dashboard | No widget/overlay/shortcut APIs |

## Safety model / invariants

- **Never override a user interrupt**: no continue on `status: 'cancelled'` or `'error'`.
- **One active session per workdir** (lock file); one workdir per session; **one
  experiment in flight per workdir** (single-flight lock).
- **The plugin only executes repo-committed scripts** (`measure.sh`, `checks.sh`,
  hooks), never agent-supplied command strings.
- **`.auto/` always survives reverts** (exclusion globs on checkout and clean).
- **No git surprises**: init hard-refuses dirty worktrees (no override), requires
  confirmation for default branches and for the resolved workdir at first activation;
  all git ops run in the validated workdir only.
- **Auto-resume is capped** (default 20, `maxAutoResumeTurns` configurable) and the cap
  only resets on genuine user input.
- **Fail closed**: destructive confirmations default to refusal when UI is unavailable;
  sessions deactivate with a notification when their on-disk state disappears.
- **Benchmark subprocesses are always reaped**: plugin-owned kill timers (process-group
  kill) plus thread-state polling, since Amp gives tools no abort signal. Documented:
  Ctrl-C does not instantly kill an in-flight benchmark.
- **Disk is the source of truth**: any state that must survive a plugin reload lives in
  `.auto/`, never only in memory.

## Repository layout

```
amp-autoresearch/
├── autoresearch.ts          # the plugin (single file, self-contained)
├── assets/
│   └── dashboard.html       # adapted from pi's template.html; inlined at build or read at runtime
├── docs/plans/
│   └── amp-autoresearch.md  # this plan
├── test/
│   ├── jsonl.test.ts        # state reconstruction (pure)
│   ├── confidence.test.ts   # MAD scoring (pure)
│   └── fixtures/
├── Makefile                 # install (symlink), test, lint
└── README.md
```

Pure logic (jsonl parsing/reconstruction, confidence, digest rendering, metric parsing)
is written as exported functions in the plugin file so `bun test` can import them
directly. If the file grows unwieldy, split into modules with `autoresearch.ts` as the
entry — Amp loads the file via Bun, which resolves relative imports.

## Delivery strategy

### Slice 0 — Spike: verify undocumented host behavior (throwaway)

The design leans on three undocumented behaviors. Verify with a scratch plugin before
building:

1. `agent.start` fires for plugin-appended messages (`thread.appendUserMessage`) and for
   `agent.end → continue`-originated turns.
2. `agent.end → {action:'continue'}` chains for 3+ consecutive turns without host
   interference.
3. Plugin tool `execute` has no hidden timeout shorter than a long benchmark (test with
   a 5-minute sleep).
4. Whether plugin tool calls are subject to Amp's permission/approval prompts (the
   measure.sh-only restriction stands regardless; this determines how prominently the
   README must warn about unmoderated execution).

Also confirm: `ctx.thread` present in palette command context in the CLI, status-item
rendering in the CLI client, and `thread.state` observability from inside a running
tool `execute` (needed for orphaned-benchmark reaping).

**Done when:** each behavior confirmed or a workaround chosen and recorded in this plan.

**Results (2026-07-05, spike run against the live CLI in `-x` mode):**

1. ✅ `agent.end → {action:'continue'}` chains cleanly: 3 consecutive continue turns,
   host waits for the whole chain before exiting execute mode.
2. ✅ `agent.start` fires for continue-originated turns. ⚠️ In 1 of 3 runs it did not
   fire for the *first* turn (likely a handler-registration race on fast startup) —
   confirms injection must stay best-effort, which the self-contained resume messages
   already handle.
3. ✅ No hidden tool timeout: a 310s tool execution completed normally.
4. ✅ Plugin tools run with **no approval prompt** — confirms the measure.sh-only
   restriction is necessary; README must state it prominently.
5. ⚠️ **`thread.appendUserMessage` and `thread.state` fail in execute mode** with
   "not available - no active thread" (from both tool and `agent.end` handler
   contexts). They depend on an active (UI-focused) thread. Consequences:
   - `run_experiment`'s thread-state polling must degrade to kill-timer-only when
     state is unavailable (wrap in try/catch).
   - The `start` command's kickoff append gets a fallback: on failure, notify the
     user to send the kickoff text manually.
   - Interactive-mode behavior of both APIs is verified at the Slice 4 smoke test.

### Slice 1 — Scaffold + state core

Repo scaffold, Makefile (symlink install), and the pure core: jsonl
parse/reconstruct (port of pi's `jsonl.ts`), confidence scoring, `METRIC` line parser,
digest renderer, `.auto/` path helpers, `amp-session.json` read/write. Unit tests for
all of it.

**Done when:** `bun test` green; fixtures include a real pi-generated `log.jsonl`.

### Slice 2 — Tools

`init_experiment` (workdir validation, git guards, lock acquisition, config header),
`run_experiment` (spawn + kill timer, METRIC parsing, checks.sh, truncation, before
hook), `log_experiment` (jsonl append, commit/revert, confidence, scoreboard rendering,
after hook, maxIterations). Registered in the plugin; testable manually by asking the
agent to call them.

**Done when:** a manual (non-looping) init → run → log cycle works end-to-end on a toy
repo: keep commits land, discard reverts preserve `.auto/`, scoreboard renders.

### Slice 3 — Loop, session persistence, lock

`agent.end` continue handler with all gates; `agent.start` digest injection + cap reset;
resume message; lazy session reload; lock enforcement; stop-on-cap notification.

**Done when:** on the toy repo, the loop runs ≥5 unattended iterations, survives
`plugins: reload` mid-session (same thread resumes; a second thread is refused), and a
user Ctrl-C stops it without a bounce-back turn.

### Slice 4 — Commands + kickoff prompt

The five palette commands with availability wiring, goal input dialog, kickoff message
(create-skill port + resume variant), worktree/branch guards at start, clear/stop flows.

**Done when:** full cold-start UX works: palette start → goal dialog → agent writes
`.auto/` files → baseline → loop, with no manual tool prompting.

### Slice 5 — Dashboard + status item

Bun HTTP server (dashboard HTML, `/log.jsonl`, SSE), adapted template, per-workdir
server lifecycle, `autoresearch: dashboard` command, experimental status item with
click-through. Server teardown on stop/unload.

**Done when:** dashboard live-updates during a running loop; status item tracks
runs/best; both survive plugin reload.

### Slice 6 — Hardening + docs

UI-unavailable fallbacks everywhere; hook payload parity with pi (JSON on stdin, 30s
timeout, 8KB stdout cap); `.auto/config.json` `workingDir`/`maxIterations`/
`maxAutoResumeTurns` honored; concurrent-thread tests; README (install, usage, file
formats, differences from pi, trust notes: hooks/measure/checks are repo-local scripts
executed on the user's behalf once a session is started in that repo, and cancel
latency for in-flight benchmarks); final oracle code review.

**Done when:** oracle review passes with no high-severity findings; README complete.

## Verification

- **Unit** (bun test): jsonl reconstruction (incl. multi-segment logs and a
  pi-generated fixture), confidence scoring against pi's known outputs, METRIC parsing
  edge cases, digest rendering, session-file round-trip, structural resume-message
  detection (cap reset survives simulated reload).
- **Integration** (scripted, toy git repo): keep commits contain the jsonl line; revert
  preserves `.auto/`; init refuses dirty worktrees, wrong-repo `working_dir` paths
  without confirmation, and non-`measure.sh` execution; single-flight lock rejects a
  concurrent `run_experiment`; checks_failed blocks keep; maxIterations aborts; missing
  `log.jsonl` at resume time deactivates instead of continuing.
- **Host smoke** (manual, per slice done-criteria): loop longevity, reload recovery,
  cancel behavior (including orphaned-benchmark reaping), lock contention between two
  threads, dashboard SSE, CLI vs. IDE client UI availability.
- **Format compatibility**: a `.auto/` directory produced by amp-autoresearch loads in
  pi-autoresearch and vice versa (spot check with pi's dashboard template against our
  log.jsonl).

## Resolved decisions

- Repo at `~/Develop/lox/amp-autoresearch`, installed by symlink into
  `~/.config/amp/plugins/`. System-wide plugin (not per-project).
- pi-compatible `.auto/` layout, current format only; no legacy flat-file support.
- Required `working_dir` parameter on `init_experiment`; no `process.cwd()` anywhere.
- Tools gate on initialized session, not a mode flag; mode concept exists only for
  auto-resume and injection.
- Gate auto-resume on successful `log_experiment` in the turn, `status === 'done'`, and
  the resume cap (default 20, `maxAutoResumeTurns` override); cap resets on
  user-originated turns detected structurally.
- Keep commits happen before the jsonl append so keep rows carry the accurate
  post-commit sha (pi's order); the stale-log-in-commit hazard is closed by
  gitignoring `.auto/log.jsonl` + `.auto/amp-session.json` in the kickoff instead.
  (Reverses an earlier decision that traded sha accuracy for commit completeness.)
- `run_experiment` executes only `.auto/measure.sh` — no arbitrary command parameter
  (deliberate hardening over pi).
- No dirty-worktree override at init: hard refusal, "commit or stash first". Confirm
  dialogs only for recoverable choices (default branch, workdir identity).
- Hooks report via tool results, not steer messages.
- Browser dashboard is v1 scope (it carries the monitoring UX that pi's TUI overlay
  carried).
- Experimental APIs used: `createStatusItem` only, degrade gracefully if unavailable.

## Open questions

1. **Auto-open dashboard on start?** Default: no; notify with the command name instead.
   Trigger to revisit: users consistently running `dashboard` right after `start`.
2. **`amp-session.json` inside `.auto/` gets committed on keep** (pi commits `.auto/`
   too unless gitignored). Options: recommend gitignoring `.auto/amp-session.json` in
   the kickoff prompt (default), or store sessions under
   `~/.config/amp/autoresearch/sessions/<hash>.json`. Workdir-local file is preferred
   because the lock travels with the repo; revisit if committed session files cause
   confusion.
3. **Model/mode guidance for the loop thread** — the loop quality depends on the
   thread's agent mode (user's choice today). v2's `registerAgentMode` could ship an
   "autoresearch" mode with pinned instructions; deferred until per-turn injection
   proves insufficient.

## Key learnings from pressure-testing

Two adversarial passes were run; all corrections are folded in above.

**Round 2 (adversarial review of this plan):**

- **`run_experiment`-as-arbitrary-shell was a trust-boundary regression**: plugin tools
  sidestep the approval scrutiny Amp users expect for Bash → pinned execution to
  `.auto/measure.sh` only (hardening over pi; whether Amp approval covers plugin tools
  is checked in Slice 0).
- **The dirty-worktree confirm-override was a trap**: overriding guarantees the user's
  uncommitted changes are destroyed at the first discard; the original verification
  bullet even asserted the opposite of real `git clean` semantics → hard refusal, and
  the verification test was corrected.
- **Agent-supplied `working_dir` can be a wrong-but-valid repo** (dotfiles in `$HOME`)
  → confirm the resolved realpath with the user at first activation.
- **No single-flight guard meant cancel + resume could run two concurrent benchmarks**
  (Amp tools get no abort signal) → per-workdir in-flight lock + thread-state polling.
- **Exact-match cap-reset detection breaks across plugin reloads**, silently disabling
  the auto-resume cap → structural detection of resume messages.
- **Branch switches strand sessions** (committed `.auto/` files vanish, untracked
  session file persists) → fail closed: deactivate + notify when `log.jsonl` is missing.
- **The fixed 20-resume cap made unattended overnight runs impossible** →
  `maxAutoResumeTurns` config override.

**Round 1 (oracle review of the initial design):**

- **The cwd assumption was the biggest hole**: no workspace-root API exists for Amp
  plugins, and a system plugin serves many projects per process → explicit
  `working_dir` on `init_experiment`, validated and persisted per thread.
- **`agent.end` fires on cancelled/error turns** → gating on `status === 'done'` is
  mandatory or the loop overrides user interrupts and loops on failures.
- **In-memory turn counters don't survive reloads** → detect "turn logged an
  experiment" from `event.messages` via `toolCallsInMessages`, not a counter.
- **The resume cap would brick the loop permanently** without a reset on genuine user
  messages.
- **Whether `agent.start` fires for plugin-originated messages is undocumented** →
  resume messages are self-contained (digest embedded), and Slice 0 verifies the
  behavior empirically before anything is built on it.
- **Per-turn full-rules injection bloats context** in exactly the long-running sessions
  this plugin exists for → digest-only injection; rules live once.
- **No abort signal in tool execute** → plugin-owned subprocess kill timers; documented
  cancel latency.
- **Two threads on one repo corrupt each other's git state** → workdir lock file.
- **pi has a latent ordering bug** (jsonl appended after `git add -A`) → don't copy it.
- **Dirty worktrees turn `git add -A`/`git clean -fd` into data loss** → init guards.
