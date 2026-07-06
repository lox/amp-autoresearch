---
name: autoresearch-finalize
description: Finalize an amp-autoresearch session into clean, independently-mergeable review branches — one per logical change, each cut from the merge-base. Use when asked to "finalize autoresearch", "clean up the experiment branch", or "prepare autoresearch results for review".
---

# Finalize Autoresearch

Turn a noisy autoresearch branch into clean, independent branches — one per logical
change, each starting from the merge-base. The experiment branch is a log, not a
reviewable history; this skill extracts the net changes into commits written for
reviewers.

Adapted from pi-autoresearch's finalize skill (MIT,
https://github.com/davebcn87/pi-autoresearch).

## Step 1 — Analyze and Propose Groups

1. Read `.auto/log.jsonl`. Filter to **kept** experiments only.
2. Read `.auto/prompt.md` for session context.
3. **Check `.auto/ideas.md` for a "Final review" section** (written by the
   end-of-session oracle review). If it recommends reverting or simplifying any kept
   commit, surface those verdicts in your proposal: default to excluding
   revert-recommended commits from the groups, and say so — the user decides.
4. Expand all short commit hashes to full hashes: `git rev-parse <short_hash>`.
5. Get the merge-base: `git merge-base HEAD main` (or the repo's default branch).
6. For each kept commit, get the diff stat (`$BASE..<commit>` for the first,
   `<prev_kept>..<commit>` for subsequent).
7. Group kept commits into logical changesets:
   - **Preserve application order.** Group N comes before Group N+1.
   - **No two groups may touch the same file.** Each branch is applied to merge-base
     independently — overlapping files would conflict. If two groups touch the same
     file, merge them into one group.
   - **Watch for cross-file dependencies.** If group 1 adds an API and group 2 calls
     it, group 2's branch won't work in isolation. Flag it ("group 2 depends on
     group 1 — review together") or merge the groups when the dependency is tight.
   - **Keep each group small and focused.** One idea, one theme per group.
   - **Don't hardcode a count.** Could be 1, could be 15.

Present the proposed grouping to the user:

```
Proposed branches (each from merge-base, independent):

1. **Skip redundant initrd probe** (commits abc1234, def5678)
   Files: guest/minimal-initrd/agent.c
   Metric: 77ms → 58ms (-24.7%)
   Final review: keep as-is

2. **Cache cmdline parse** (commit ghi9012)
   Files: src/boot/cmdline.zig
   Metric: 58ms → 40ms (-31.0%)
   Final review: simplify before merging (see ideas.md)
```

**Wait for approval before proceeding.**

## Step 2 — Write groups.json and Run

Write `/tmp/groups.json`:

```json
{
  "base": "<full merge-base hash>",
  "trunk": "main",
  "final_tree": "<full hash of current HEAD>",
  "goal": "short-slug",
  "groups": [
    {
      "title": "Skip redundant initrd probe",
      "body": "Why + what changed.\n\nExperiments: #3, #5\nMetric: tti_ms 77 → 58 (-24.7%)",
      "last_commit": "<full hash of last kept commit in this group>",
      "slug": "initrd-probe"
    }
  ]
}
```

Key rules:

- **`last_commit` must be a full hash.** Expand jsonl short hashes with `git rev-parse`.
- **No two groups may share a file.** The script validates this and fails if violated.
- If the approved plan excludes a revert-recommended commit whose files a later kept
  commit also touched, the later commit's snapshot still contains the excluded change
  — call this out and merge or re-group until the exclusion is real.

Then run (paths relative to this skill's base directory):

```bash
bash <skill-base-dir>/finalize.sh /tmp/groups.json
```

The script creates one branch per group from the merge-base
(`autoresearch/<goal>/<NN>-<slug>`), verifies the union of all groups matches the
original branch tree, and prints a summary with branches, cleanup commands, and any
remaining ideas from `.auto/ideas.md`.

On creation failure: rolls back (deletes created branches, restores the original
branch, pops the stash). On verification failure: exits non-zero but leaves branches
intact for inspection.

## Step 3 — Report

- Branches created and what each contains.
- Overall metric improvement (baseline → best).
- The cleanup commands from the script's summary.
- Any final-review verdicts the user still needs to act on.

## Edge Cases

- **Only 1 kept experiment**: one branch is fine — don't force splits.
- **Overlapping files between groups**: the script fails naming the file; merge the
  overlapping groups and retry.
- **Non-experiment commits on the branch** (session setup, gitignore): skip them —
  only kept experiments from the jsonl matter; `.auto/` files are excluded
  automatically.
- **Session still active**: finalize on a stopped session. If `.auto/amp-session.json`
  says `"active": true`, ask the user to stop the loop first.
