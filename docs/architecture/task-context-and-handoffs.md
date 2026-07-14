# Task context and agent handoffs

Phase 3 introduces a durable `Task` above provider-specific threads without redesigning the
existing thread runtime. A thread remains the unit of provider execution, checkpoints, diffs,
approvals, and terminal attachment. A task owns the provider-neutral context shared by those
threads.

```text
Task
  title
  shared goal
  canonical context

  Sessions
    Claude thread
    Codex thread
    future provider thread
```

## Durable model

`OrchestrationTask` is part of the event-sourced read model and shell snapshot. It contains:

- a stable task ID and parent project ID;
- a user-editable title, goal, and canonical context;
- the IDs of its provider-session threads;
- creation, update, and deletion timestamps.

Threads carry a `taskId`. Migration 33 creates `projection_tasks`, adds the thread foreign-key
column, and backfills every existing thread into a stable `legacy-{threadId}` task. The wire schemas
retain decoding defaults for snapshots and events written before Phase 3.

Ordinary thread creation still emits the established `thread.created` event sequence. Both the
in-memory projector and SQL task projector infer the legacy task from that event. Explicit task
sessions, including handoffs, carry the real task ID.

## Handoff transaction

The client dispatches one `task.handoff.start` command containing the source task/session, target
provider/model, target thread identity, runtime settings, and optional receiving instructions. The
server validates that the source thread belongs to the task, materializes the handoff prompt from
durable state, and atomically decides:

1. `thread.created` for the target session;
2. `thread.message-sent` with the materialized context;
3. `thread.turn-start-requested` for the receiving provider.

The browser never supplies the canonical handoff prompt. This prevents stale client state from
silently replacing the server's task context.

The prompt is plain Markdown and therefore provider-neutral. It contains bounded sections for the
task goal and context, source provider/model/worktree, recent completed messages, latest proposed
plan, latest changed-file summary, and optional instructions. Individual sections and the complete
prompt have explicit size limits.

## Client synchronization

Task changes are delivered through typed shell stream events. The header's task control edits the
shared context, lists sibling sessions, and starts a handoff to any ready provider/model. After the
handoff command succeeds, the client waits for the target thread detail to enter started state
before navigating. If synchronization times out, the already-created session remains visible in
the sidebar and a non-destructive warning is shown.

## Deliberate limits

- A task is currently created implicitly for each normal thread. There is no separate task inbox or
  task-creation screen.
- Handoffs are sequential continuations in the same branch/worktree. Isolated parallel worktrees
  remain a later orchestration phase.
- Context is curated text plus bounded derived session state. Automatic context compaction,
  decision extraction, outcome scoring, and cost-aware routing are not part of Phase 3.
- Threads remain provider sessions. Their checkpoint, diff, terminal, approval, and persistence
  semantics are unchanged.
