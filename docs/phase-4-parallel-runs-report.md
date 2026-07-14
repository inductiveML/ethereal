# Phase 4 parallel agent runs report

## Objective

Phase 4 adds durable parallel runs beneath Ethereal's provider-neutral task context. One action can
start multiple coding-agent sessions with the same canonical context while assigning every worker
its own Git branch and worktree. It does not add automatic merging, a task graph, Fable review,
cost-based routing, or a general scheduler.

## Baseline

- Base commit: `ffa9846a6b85f6ef9d0473107e73f767c57ac0c0`
- Integration branch: local `main`
- Node: `v24.5.0`
- Vite+: `v0.2.2`
- `vp check`: passed with nine existing React nested-component warnings.
- `vp run typecheck`: passed across 11 workspaces.

The baseline already contained Phase 1's local-first desktop cleanup, Phase 2's sole Claude Code
PTY runtime, and Phase 3's durable task context and Claude/Codex handoffs. Codex app-server,
provider-neutral events, terminals, approvals, checkpoints, diffs, persistence, and Git worktrees
were all working before this phase.

## Implemented

### Durable run aggregate

- Added branded run IDs plus task-run and worker schemas.
- Added the bounded `task.run.start` command and `task.run-started` event.
- Added task-run projection, shell-stream, snapshot, reducer, and persistence support.
- Added migration 34 with a `runs_json` task-projection column.
- Retained the newest 100 task runs in projections while preserving all events in the event store.
- Kept workers as normal provider threads so existing terminal, diff, checkpoint, approval, and
  recovery behavior continues to apply.

### Isolated worktree orchestration

- Validated task, project, source-session, worker-ID, branch-prefix, and worktree invariants.
- Prepared every worker branch and worktree before committing the run event batch.
- Serialized Git preparation to avoid repository lock contention.
- Ran project setup scripts only for newly created worktrees.
- Atomically emitted the run record plus worker thread creation, first message, and turn-start
  events.
- Materialized canonical task context and worker instructions on the server.
- Reused existing branches/worktrees on retry and recreated a worktree when only the branch
  remained.
- Rolled back worktrees and setup terminals created by a failed attempt without deleting existing
  branches.

### Reliable provider startup

The first live run found two concrete startup failures:

1. Claude Code stopped on its workspace-trust prompt because each worker worktree was new.
2. The shared run command ID caused turn-start deduplication to suppress every worker after the
   first.

The final implementation fixes both:

- provider-turn deduplication is keyed by command ID, thread ID, and event type;
- only a thread whose exact path is recorded in a durable task run receives the
  `workspaceTrust: "app-created"` hint;
- the Claude PTY accepts only the complete workspace-trust prompt containing that exact path;
- ordinary folders still require manual trust;
- the trust hint is persisted in provider runtime state for recovery.

### Desktop UX

- Added a parallel-run panel to the task-context dialog.
- Added run title, shared brief, worker label, provider/model, and worker-specific instruction
  controls.
- Added run history with linked worker branch and current thread-derived status.
- Shipped a focused two-worker UI while keeping the contract ready for two through six workers.
- Displayed the three most recent runs while retaining the bounded durable history.

## Automated validation

| Command                                       | Result                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| `vp check`                                    | Passed; 1,415 files formatted, zero errors, nine pre-existing React warnings |
| `vp run typecheck`                            | Passed across 11 workspaces                                                  |
| focused run/trust/deduplication tests         | Passed before the final suite; 5 files, 109 tests                            |
| `vp test`                                     | Passed: 426 files, 2 skipped; 3,409 tests, 7 skipped                         |
| `vp run test`                                 | Passed: 158 files, 2 skipped; 1,295 tests, 7 skipped                         |
| `vp run build:desktop`                        | Passed; only existing source-map and chunk-size warnings                     |
| `vp run --filter @t3tools/desktop smoke-test` | Passed; desktop readiness log observed                                       |
| `git diff --check`                            | Passed                                                                       |

Git-backed tests were run with commit signing disabled in their temporary repositories. The full
suites and desktop smoke were run with the permissions needed for loopback sockets and Electron's
macOS registration checks.

## Live desktop testing

The development Electron app was exercised with the user's existing subscription-authenticated
Claude Code CLI and Codex installation.

1. Opened the Phase 3 task and its task-context dialog.
2. Started run `PHASE4 fixed parallel smoke` from one action.
3. Assigned Claude Haiku 4.5 and Codex GPT-5.6-Sol with distinct exact-reply instructions.
4. Confirmed Ethereal created two different branches and worktrees:
   - `ethereal/run/201be44c-630a-428a-a670-e232bd4fc155/1-worker-1`
   - `ethereal/run/201be44c-630a-428a-a670-e232bd4fc155/2-worker-2`
5. Confirmed both worker sessions appeared under the original task.
6. Confirmed Claude passed the app-created workspace trust gate and replied exactly
   `PHASE4_CLAUDE_FIXED_OK` without using tools or editing files.
7. Confirmed Codex replied exactly `PHASE4_CODEX_FIXED_OK` without using tools or editing files.
8. Confirmed the run panel showed both workers as ready with their distinct worktree paths.
9. Quit and relaunched the desktop application.
10. Confirmed the run record, both linked sessions, both exact responses, both branches, and both
    worktree paths survived restart.

## Preserved intentionally

- Claude's subscription-authenticated interactive PTY, JSONL transcript ingestion, native user
  input including `AskUserQuestion`, approvals, interrupt/resume, and raw PTY escape hatch.
- Codex app-server integration and the additional provider adapters.
- Provider-neutral runtime events, task context, handoffs, model/account selection, and runtime
  modes.
- `node-pty`, terminal sessions, xterm, split/resize/input/output, setup terminals, and terminal
  context attachment.
- Git worktrees, checkpoints, turn diffs, revert support, persistence, and restart recovery.
- SSH, browser preview, preview annotations, MCP, file trees, and diff rendering.

## Remaining risks and later candidates

- Run status is derived from worker threads; there is no explicit group completion, failure,
  cancellation, or retry state machine yet.
- A failed or interrupted run can remain visible with its last worker-derived statuses.
- Worktrees need a group cleanup command and a safe merge/review lifecycle.
- The UI should eventually support dynamic two-to-six-worker composition instead of a fixed pair.
- Parallel setup scripts are launched during sequential preparation; dependency-heavy repositories
  may need resource limits and readiness gates before provider turns begin.
- Run-level cost, usage, latency, outcomes, retries, and routing decisions are not yet aggregated.
- Planner/worker/reviewer task graphs and Fable review remain future work.
- Nine unrelated React nested-component warnings and existing build source-map/chunk warnings remain.

## Commit list

- `c47ea18c` `feat: add durable parallel task runs` — contracts, event model, projections,
  migration, isolated worktree preparation, rollback/retry behavior, and server tests.
- `de43ccc5` `feat: expose isolated parallel runs` — two-worker desktop controls, provider/model
  selection, and run history/status.
- `aeb7b7b9` `fix: start all parallel workers reliably` — command/thread-aware deduplication,
  verified Claude app-created-worktree trust, recovery persistence, and regressions.
- `docs: document phase 4 parallel runs` — architecture notes and this validation report.

## Result

Ethereal can now start a durable Claude/Codex worker group from shared task context, isolate every
worker in its own Git worktree, run the providers independently, and recover the complete run after
an application restart. All Phase 1 through Phase 4 commits are incorporated on local `main`.
