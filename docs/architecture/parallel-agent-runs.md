# Parallel agent runs

Phase 4 added a durable run aggregate beneath a task and above the provider threads that perform
the work. Phase 5 adds an explicit run lifecycle and safe group cleanup. Threads remain the unit of
provider execution, approvals, terminals, checkpoints, and diffs. A task run records why a group
of threads was started together, which isolated Git worktree belongs to each worker, and whether
the group is active, stopping, ready for review, or cleaned.

```text
Task
  shared goal
  canonical context

  Runs
    run title + shared brief
    Worker 1 -> Claude thread -> isolated branch/worktree
    Worker 2 -> Codex thread  -> isolated branch/worktree

  Sessions
    ordinary and handoff threads
```

## Durable model

`OrchestrationTaskRun` is stored on the task projection and included in shell snapshots. A run
contains a stable run ID, source thread, title, shared instructions, creation time, and two to six
worker records. Each worker records its thread, label, provider/model selection, branch, and exact
worktree path. The run also stores a durable status and the time of the latest status transition.
Historical Phase 4 run records decode as `active` with no transition time.

Migration 34 adds `runs_json` to the task projection. Projectors retain the newest 100 runs in the
read model so shell snapshots remain bounded; the event store still preserves the underlying
`task.run-started` events. The first desktop tracer-bullet UI deliberately exposes two workers and
the three most recent runs even though the contract supports two through six workers.

## Start transaction

The client dispatches one `task.run.start` command with stable run, worker, thread, message, and
branch IDs. The server validates task/project/session ownership, then prepares each worktree before
committing orchestration events. Git preparation is sequential to avoid repository lock
contention. If a project setup script exists, it runs only for a newly created worktree.

After every worker has a real isolated path, the orchestration engine atomically decides:

1. `task.run-started` for the durable run record;
2. `thread.created` for every worker session;
3. `thread.message-sent` with server-materialized canonical task context and worker instructions;
4. `thread.turn-start-requested` for every provider.

The shared command ID ties the event batch together. Provider-turn deduplication also includes the
thread ID and event type, so multiple worker starts from the same command cannot suppress one
another. Once the batch is committed, the provider reactor starts each session and forks the turn
work, allowing the agent turns to overlap.

## Failure and retry behavior

Worktrees created by the current attempt are tracked until the event transaction succeeds. If
preparation or dispatch fails, Ethereal closes setup terminals launched by that attempt and removes
those worktrees in reverse order. Existing branches are not deleted.

A retry with the same run ID reuses the durable worker paths. Before a run has committed, retrying
also reuses an existing worker worktree or recreates a worktree for an existing worker branch. This
keeps retries idempotent without silently discarding branch state.

## Claude workspace trust

Claude Code asks for confirmation the first time it opens a new worktree. Ethereal marks a session
as `workspaceTrust: "app-created"` only when the thread and exact worktree path are present in a
durable task run. The Claude PTY adapter then accepts only the full workspace-trust prompt that
contains that exact path. The hint is persisted with provider runtime state so session recovery
uses the same rule.

Ordinary projects, manually selected folders, and paths that do not exactly match a durable run
worker remain subject to Claude's normal manual trust prompt.

## Durable lifecycle

Run state changes are orchestration commands and events, not UI-only derivations:

```text
active ────────────────> review-ready ────────────────> cleaned
   │                            ▲
   └────> cancel-requested ─────┘
                  └───────────────────────────────────> cleaned
```

- `task.run.cancel` first records `cancel-requested`, then requests interruption for every running
  worker turn and session stop for every live worker session in the same orchestration decision.
- `task.run.mark-review-ready` is accepted only after every worker turn has settled. It records the
  review boundary and stops any idle provider sessions that remain open.
- Both transitions close every worker's in-app terminal sessions after successful dispatch.
- The explicit review boundary keeps automatic heuristics from declaring a run complete while a
  provider is reconnecting, waiting for approval, or reporting a late failure.

The shell projection streams the durable status, so reconnects and restarts render the same run
state rather than reconstructing it from transient provider processes.

## Safe worktree cleanup

Cleanup is conservative and branch-preserving:

1. The run must be `review-ready` or `cancel-requested` and every worker session must be stopped.
2. Every recorded worker branch must still exist locally.
3. A checked-out branch must still be at the exact worktree path recorded by the run.
4. The server preflights every worktree before removing any of them and refuses the whole cleanup
   when one worktree is missing, not a Git repository, or has uncommitted changes.
5. Worktrees are removed sequentially with Git's non-force operation. Worker branches and commits
   are never deleted.
6. If a later removal or the durable status dispatch fails, already removed worktrees are recreated
   at their exact recorded paths in reverse order.
7. After success, worker thread projections clear their live `worktreePath`; the run retains its
   historical worker record and moves to `cleaned`.

If the process exits after a physical removal but before the status event commits, retry sees the
preserved branch without a worktree, removes any remaining worktrees, and completes the durable
transition.

## Deliberate limits

- The desktop form starts exactly two workers; dynamic two-to-six-worker editing is a later UX
  step.
- Review readiness is explicit. There is no automatic completion detector, retry scheduler, or
  retry dashboard.
- Ethereal removes worktrees as a group, but it does not yet merge branches or provide a combined
  review/merge workflow.
- Cost, latency, outcome, retry, and routing metrics are not yet aggregated at the run level.
- Task graphs, planner/worker/reviewer roles, and Fable review orchestration remain future phases.
