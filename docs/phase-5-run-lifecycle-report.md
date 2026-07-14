# Phase 5 parallel run lifecycle report

## Objective

Phase 5 turns Phase 4's durable parallel-run record into an operable lifecycle. A user can stop all
workers, explicitly mark a settled run ready for review, and safely remove the run's clean
worktrees without deleting worker branches or commits. It does not add automatic merging, retry
scheduling, a planner/reviewer graph, Fable, or run-level cost routing.

## Baseline

- Base commit: `632fd701` (`docs: document phase 4 parallel runs`)
- Integration branch: local `main`
- Node: `v24.5.0`
- Vite+: `v0.2.2`
- `vp check`: passed with nine existing React nested-component warnings.
- `vp run typecheck`: passed across 11 workspaces.
- Phase 4 desktop build, automated tests, Electron smoke test, Claude/Codex parallel run, and restart
  recovery were green before this phase.

## Implemented

### Durable run state

- Added `active`, `cancel-requested`, `review-ready`, and `cleaned` run states plus transition time.
- Added provider-neutral cancel, mark-review-ready, and cleanup commands.
- Added a durable run-status event and projected it through in-memory, SQLite, shell-stream, and
  client-reducer paths.
- Kept old Phase 4 records compatible by decoding missing status fields as `active` and `null`.
- Clear worker thread `worktreePath` values after cleanup while preserving the historical paths on
  the run record.

### Group cancellation and review boundary

- Cancel records the group transition before emitting worker turn-interrupt and session-stop
  requests.
- Review-ready is rejected until every worker turn is settled.
- Review-ready stops idle provider sessions that remain open.
- Both lifecycle actions close worker terminal sessions after successful dispatch.
- The UI derives action availability conservatively from durable run state plus current worker
  session state.

### Safe cleanup

- Requires a review-ready or cancelled run whose worker sessions are all stopped.
- Verifies every worker branch still exists and is checked out only at its recorded run path.
- Preflights all worktrees as Git repositories with clean working trees before removing any path.
- Refuses dirty worktrees with an actionable error.
- Uses sequential, non-force `git worktree remove`; branches and commits remain intact.
- Recreates already removed worktrees at their exact paths if a later removal or durable dispatch
  fails.
- Treats a preserved branch with no worktree as retryable after an interrupted cleanup.
- Requires a desktop confirmation that explicitly states the branch-preservation and dirty-tree
  safeguards.

### Desktop UX

- Added durable Active, Stopping, Review ready, and Cleaned badges to run history.
- Added Stop workers, Ready for review, and Clean worktrees controls only when their invariants are
  satisfied.
- Added success and failure notifications for each transition.
- Retained the focused two-worker creation form and three-run history limit from Phase 4.

## Automated validation

| Command                                       | Result                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| `vp check`                                    | Passed; 1,418 files formatted, zero errors, nine pre-existing React warnings |
| `vp run typecheck`                            | Passed across 11 workspaces                                                  |
| focused lifecycle/server/UI tests             | Passed: 4 files, 120 tests                                                   |
| `vp test`                                     | Passed: 427 files, 2 skipped; 3,420 tests, 7 skipped                         |
| `vp run test`                                 | Passed: 158 files, 2 skipped; 1,301 tests, 7 skipped                         |
| `vp run build:desktop`                        | Passed; only existing source-map and chunk-size warnings                     |
| `vp run --filter @t3tools/desktop smoke-test` | Passed; desktop readiness log observed                                       |
| `git diff --check`                            | Passed                                                                       |

The server integration tests cover clean removal, dirty-worktree refusal, exact-path rollback after
a later removal fails, and terminal closure after group cancellation. Git-backed tests ran with
commit signing disabled in their temporary repositories. Loopback and Electron tests ran with the
permissions needed for local sockets and macOS application startup.

## Live desktop testing

The development Electron app was exercised against the durable `PHASE4 fixed parallel smoke` run:

1. Opened the existing Claude worker and the shared task-context dialog.
2. Confirmed the run initially rendered `Active`, with both Claude and Codex workers ready.
3. Selected Ready for review.
4. Confirmed the success notification, durable `Review ready` badge, and both worker sessions moving
   to stopped.
5. Confirmed Clean worktrees appeared only after both sessions stopped.
6. Quit the desktop app and stopped the development server.
7. Relaunched Electron against the same local data.
8. Reopened the task and confirmed `Review ready`, both stopped workers, their preserved branches and
   worktree paths, and the cleanup action all survived restart.
9. Closed the app and development server cleanly.

Live cleanup was intentionally not triggered because it would remove the user's existing Phase 4
worktrees. The destructive path is covered by server integration tests, including rollback and
dirty-tree refusal.

## Preserved intentionally

- Claude's subscription-authenticated interactive PTY, JSONL transcript ingestion, native
  `AskUserQuestion`, approvals, interrupt/resume, and raw PTY escape hatch.
- Codex app-server integration and the additional provider adapters.
- Provider-neutral runtime events, durable task context, handoffs, model/account selection, and
  runtime modes.
- `node-pty`, terminal sessions, xterm, split/resize/input/output, setup terminals, and terminal
  context attachment.
- Git branches, worktrees, checkpoints, turn diffs, revert support, persistence, and restart
  recovery.
- SSH, browser preview, preview annotations, MCP, file trees, and diff rendering.

## Remaining risks and later candidates

- Completion remains an explicit user action; automatic completion needs a recovery-aware state
  machine rather than a thread-status heuristic.
- Cleanup preserves branches but there is no combined branch review, comparison, selection, or
  merge workflow.
- A process crash during cleanup relies on a retry to finish remaining worktrees and commit the
  durable state.
- The UI still creates exactly two workers even though the contract supports two through six.
- There is no run-level retry policy, concurrency/resource budget, cost, usage, latency, outcome, or
  routing telemetry.
- Planner/worker/reviewer graphs and Fable review remain future work.
- Nine unrelated React nested-component warnings and existing build source-map/chunk warnings
  remain.
- The live development run logged non-blocking Chromium cache-directory, unavailable Grok health,
  LegendList recycling, and shutdown-time preview-focus warnings; readiness and lifecycle behavior
  were unaffected.

## Commit list

- `db25b410` `feat: add durable parallel run lifecycle` — contracts, projections, cancellation,
  review boundary, terminal closure, safe cleanup, rollback, and integration tests.
- `b59f193a` `feat: add safe parallel run controls` — durable status badges, lifecycle actions,
  confirmation, notifications, and UI-state tests.
- `docs: document phase 5 run lifecycle` — architecture notes and this validation report.

## Result

Ethereal now has a durable, restart-safe parallel-run lifecycle. A group can be interrupted, moved
to an explicit review boundary, and cleaned conservatively without force or branch deletion. All
Phase 1 through Phase 5 commits are incorporated on local `main`.
