import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  TaskId,
  TaskRunId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-07-14T00:00:00.000Z";
const projectId = ProjectId.make("project-handoff");
const taskId = TaskId.make("task-handoff");
const sourceThreadId = ThreadId.make("thread-source");

const seedReadModel = Effect.gen(function* () {
  let model = createEmptyReadModel(now);
  const events: ReadonlyArray<OrchestrationEvent> = [
    {
      sequence: 1,
      eventId: EventId.make("event-project"),
      aggregateKind: "project",
      aggregateId: projectId,
      type: "project.created",
      occurredAt: now,
      commandId: CommandId.make("command-project"),
      causationEventId: null,
      correlationId: CommandId.make("command-project"),
      metadata: {},
      payload: {
        projectId,
        title: "Handoff project",
        workspaceRoot: "/tmp/handoff",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    },
    {
      sequence: 2,
      eventId: EventId.make("event-task"),
      aggregateKind: "task",
      aggregateId: taskId,
      type: "task.created",
      occurredAt: now,
      commandId: CommandId.make("command-task"),
      causationEventId: null,
      correlationId: CommandId.make("command-task"),
      metadata: {},
      payload: {
        taskId,
        projectId,
        title: "Fix streaming recovery",
        goal: "Make reconnects lossless.",
        context: "The receipt bus is the source of truth.",
        createdAt: now,
        updatedAt: now,
      },
    },
    {
      sequence: 3,
      eventId: EventId.make("event-thread"),
      aggregateKind: "thread",
      aggregateId: sourceThreadId,
      type: "thread.created",
      occurredAt: now,
      commandId: CommandId.make("command-thread"),
      causationEventId: null,
      correlationId: CommandId.make("command-thread"),
      metadata: {},
      payload: {
        threadId: sourceThreadId,
        projectId,
        taskId,
        title: "Claude investigation",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "ethereal/reconnect",
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      },
    },
    {
      sequence: 4,
      eventId: EventId.make("event-message"),
      aggregateKind: "thread",
      aggregateId: sourceThreadId,
      type: "thread.message-sent",
      occurredAt: now,
      commandId: CommandId.make("command-message"),
      causationEventId: null,
      correlationId: CommandId.make("command-message"),
      metadata: {},
      payload: {
        threadId: sourceThreadId,
        messageId: MessageId.make("message-source"),
        role: "assistant",
        text: "Instrumented reconnect ordering and found a replay race.",
        turnId: null,
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    },
  ];
  for (const event of events) model = yield* projectEvent(model, event);
  return model;
});

it.layer(NodeServices.layer)("task handoff", (it) => {
  it.effect("atomically creates a provider-neutral target session and materializes context", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const result = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "task.handoff.start",
          commandId: CommandId.make("command-handoff"),
          taskId,
          sourceThreadId,
          targetThreadId: ThreadId.make("thread-target"),
          messageId: MessageId.make("message-handoff"),
          title: "Codex implementation",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "ethereal/reconnect",
          worktreePath: null,
          instructions: "Implement the fix and run the reconnect tests.",
          createdAt: now,
        },
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.created",
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
      const created = events[0];
      expect(created?.type).toBe("thread.created");
      if (created?.type === "thread.created") expect(created.payload.taskId).toBe(taskId);
      const message = events[1];
      expect(message?.type).toBe("thread.message-sent");
      if (message?.type === "thread.message-sent") {
        expect(message.payload.text).toContain("Make reconnects lossless.");
        expect(message.payload.text).toContain("receipt bus is the source of truth");
        expect(message.payload.text).toContain("found a replay race");
        expect(message.payload.text).toContain("Implement the fix");
      }
    }),
  );

  it.effect("records and starts parallel workers in isolated worktrees", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const runId = TaskRunId.make("run-parallel");
      const result = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "task.run.start",
          commandId: CommandId.make("command-run"),
          taskId,
          runId,
          sourceThreadId,
          title: "Reconnect investigation",
          instructions: "Find independent failure modes.",
          projectCwd: "/tmp/handoff",
          baseBranch: "main",
          workers: [
            {
              threadId: ThreadId.make("thread-worker-1"),
              messageId: MessageId.make("message-worker-1"),
              label: "Runtime worker",
              title: "Runtime investigation",
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5.4",
              },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: `ethereal/run/${runId}/1-runtime`,
              worktreePath: "/tmp/worktrees/runtime",
              instructions: "Inspect receipt ordering.",
            },
            {
              threadId: ThreadId.make("thread-worker-2"),
              messageId: MessageId.make("message-worker-2"),
              label: "UI worker",
              title: "UI investigation",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: "claude-opus-4-6",
              },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: `ethereal/run/${runId}/2-ui`,
              worktreePath: "/tmp/worktrees/ui",
              instructions: "Inspect reconnect rendering.",
            },
          ],
          createdAt: now,
        },
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "task.run-started",
        "thread.created",
        "thread.message-sent",
        "thread.turn-start-requested",
        "thread.created",
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
      const runStarted = events[0];
      expect(runStarted?.type).toBe("task.run-started");
      if (runStarted?.type === "task.run-started") {
        expect(
          runStarted.payload.run.workers.map(
            (worker: { readonly worktreePath: string }) => worker.worktreePath,
          ),
        ).toEqual(["/tmp/worktrees/runtime", "/tmp/worktrees/ui"]);
      }
      const firstWorkerMessage = events[2];
      const secondWorkerMessage = events[5];
      if (firstWorkerMessage?.type === "thread.message-sent") {
        expect(firstWorkerMessage.payload.text).toContain("Find independent failure modes.");
        expect(firstWorkerMessage.payload.text).toContain("Assigned worker: Runtime worker");
      }
      if (secondWorkerMessage?.type === "thread.message-sent") {
        expect(secondWorkerMessage.payload.text).toContain("Inspect reconnect rendering.");
      }
    }),
  );
});
