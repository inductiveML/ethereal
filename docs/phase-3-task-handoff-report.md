# Phase 3 task context and handoff report

## Objective

Phase 3 adds durable provider-neutral task context above existing provider threads and makes that
context transferable between Claude and Codex sessions. It deliberately does not add Fable as a
provider, parallel run orchestration, task graphs, or automatic model routing.

## Baseline

- Base commit: `68b64781b463cfd8682cc3cba2208841726f0834`
- Branch: `ethereal/phase-3-task-handoffs`
- Node: `v24.5.0`
- Vite+: `v0.2.2`
- `vp check`: passed with nine existing React nested-component warnings.
- `vp run typecheck`: passed across 11 workspaces.

The baseline already contained the Phase 2 subscription-authenticated Claude PTY runtime, Codex
app-server integration, provider-neutral runtime events, durable threads, checkpoints, diffs,
terminals, approvals, and Git worktrees.

## Implemented

### Durable task aggregate

- Added branded task IDs and task read/shell models to the shared contracts.
- Added task create, context update, delete, and handoff commands plus task lifecycle events.
- Associated every thread with a task while preserving decoding compatibility for older events and
  snapshots.
- Added in-memory and SQL projections, snapshot queries, shell stream updates, and client reducers.
- Added migration 33 with deterministic legacy-thread backfill and lookup indexes.

### Provider-neutral handoff

- Added a single atomic `task.handoff.start` command.
- Validated task/project/session ownership before target-session creation.
- Materialized canonical context on the server from task state, recent completed messages, the
  latest proposed plan, the latest changed-file summary, and optional receiving instructions.
- Bounded individual prompt sections and the complete handoff payload.
- Reused normal thread creation and turn-start events so provider runtime semantics remain
  unchanged.

### Desktop UX

- Added a secondary task-context control in the chat header.
- Added task title, shared-goal, and canonical-context editing.
- Added sibling-session inspection and ready provider/model selection.
- Added handoff start, synchronization-aware navigation, and failure toasts.
- Kept chat, diff, terminal, checkpoint, and raw provider PTY behavior unchanged.

## Compatibility and migration

Existing threads are assigned `legacy-{threadId}` task IDs. Migration 33 creates one task row per
existing thread using the existing title and timestamps. Projectors use the same deterministic rule
when replaying older `thread.created` events. Snapshot schemas accept missing task collections and
thread task IDs during decoding, while current projections always emit them.

No provider-specific transcript or database schema was rewritten. Claude and Codex continue to own
their existing session identities and resume behavior.

## Automated validation

| Command                                         | Result                                                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `vp check`                                      | Passed; nine pre-existing React warnings                                                                       |
| `vp run typecheck`                              | Passed across 11 workspaces                                                                                    |
| focused task/migration/projection/reducer tests | Passed: 4 files, 20 tests                                                                                      |
| `vp test`                                       | Passed outside the restricted sandbox: 425 files passed, 2 skipped; 3,400 tests passed, 7 skipped              |
| `vp run test`                                   | Passed on final rerun; one earlier isolated authentication-bootstrap flake passed immediately when rerun alone |
| `vp run build:desktop`                          | Passed; only existing source-map and chunk-size warnings                                                       |
| `vp run --filter @t3tools/desktop smoke-test`   | Passed; desktop readiness log observed                                                                         |
| `git diff --check`                              | Passed                                                                                                         |

The restricted-sandbox `vp test` attempt failed because local GPG state and loopback binds were
denied. The unrestricted suite was used for the authoritative result. An initial full package-script
run hit one transient 404 in the existing authentication bootstrap test; the isolated test passed
immediately and the final full rerun passed.

## Live desktop testing

The development Electron app was exercised against the user's existing authenticated Claude and
Codex installations.

1. Opened an existing Claude thread and confirmed the task-context control appeared.
2. Saved a shared goal and canonical-context marker, closed the dialog, and confirmed both values
   reloaded from the live shell projection.
3. Handed the task from Claude Haiku 4.5 to Codex GPT-5.6-Sol.
4. Confirmed the new Codex user message contained the task title, goal, canonical context, source
   provider/model/branch, and receiving instructions.
5. Confirmed Codex replied exactly `PHASE3_HANDOFF_OK` without editing files.
6. Reopened task context and confirmed both Claude and Codex sessions were listed.
7. Handed the task back from Codex to Claude Fable 5 and confirmed navigation waited for the target
   session instead of falling back to the empty route.
8. Confirmed Claude received the prior Codex conversation and replied exactly
   `PHASE3_RETURN_OK` without editing files.
9. Restarted the desktop app and confirmed the shared goal, canonical context, all three linked
   sessions, both handoff messages, and both provider responses persisted.

The first live handoff exposed an actual client synchronization race: navigation occurred before
the target thread detail reached client state and the route redirected to the empty screen. The
handoff now waits up to five seconds for started thread state and otherwise leaves the durable
session discoverable in the sidebar with a warning.

## Preserved intentionally

- Claude's interactive PTY runtime, JSONL semantic stream, native user input, approvals, resume,
  interrupt, and raw PTY escape hatch.
- Codex app-server integration and all other provider adapters.
- Provider-neutral runtime events and provider/model/account selection.
- Thread semantics, checkpoints, turn diffs, revert support, Git worktrees, and persistence.
- `node-pty`, terminal sessions, xterm, split/resize/input/output, and terminal context attachment.
- SSH, browser preview, preview annotations, MCP, file trees, and diff rendering.

## Remaining risks and later candidates

- Consecutive handoffs can repeat an earlier materialized handoff prompt inside recent conversation.
  Context compaction should replace recursive transcript inclusion before long handoff chains become
  common.
- The task shell derives session membership from current thread projections; archived-session UX
  remains in the archived view rather than the active task dialog.
- Project force-delete filters task shells through project state but does not yet emit individual
  task tombstones.
- Handoffs currently share the source branch/worktree. Parallel workers need isolated worktree
  allocation and an explicit merge/review lifecycle.
- Task context is manually curated. Decision extraction, file/result inventories, cost/latency
  accounting, retries, and outcome scoring belong to future phases.
- Nine unrelated React nested-component warnings remain.

## Commit list

- `f9253995` `feat: add durable task context and handoffs` — contracts, commands, events, projections,
  migration, persistence, prompt materialization, and tests.
- `d5784f52` `feat: expose task context and agent handoffs` — desktop task dialog, context editing, session
  selection, handoff initiation, synchronization-aware navigation, and live-race fix.
- `docs: document phase 3 task handoffs` — architecture and validation report.

## Result

Ethereal now has a durable task above provider sessions and a working Claude-to-Codex-to-Claude
handoff path. The existing local coding-agent vertical slice remains intact.
