import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  TaskId,
  TaskRunId,
  ThreadId,
  TurnId,
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
        expect(runStarted.payload.run.status).toBe("active");
        expect(runStarted.payload.run.statusChangedAt).toBeNull();
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

  it.effect("cancels every active worker in one durable run transition", () =>
    Effect.gen(function* () {
      let readModel = yield* seedReadModel;
      const runId = TaskRunId.make("run-cancel");
      const workerThreadIds = [ThreadId.make("thread-cancel-1"), ThreadId.make("thread-cancel-2")];
      const started = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "task.run.start",
          commandId: CommandId.make("command-run-cancel-start"),
          taskId,
          runId,
          sourceThreadId,
          title: "Cancel test",
          instructions: "",
          projectCwd: "/tmp/handoff",
          baseBranch: "main",
          workers: workerThreadIds.map((threadId, index) => ({
            threadId,
            messageId: MessageId.make(`message-cancel-${index + 1}`),
            label: `Worker ${index + 1}`,
            title: `Worker ${index + 1}`,
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.4",
            },
            runtimeMode: "full-access" as const,
            interactionMode: "default" as const,
            branch: `ethereal/run/${runId}/${index + 1}-worker`,
            worktreePath: `/tmp/worktrees/cancel-${index + 1}`,
            instructions: "",
          })),
          createdAt: now,
        },
      });
      let sequence = readModel.snapshotSequence;
      for (const event of Array.isArray(started) ? started : [started]) {
        sequence += 1;
        readModel = yield* projectEvent(readModel, { ...event, sequence });
      }
      for (const [index, threadId] of workerThreadIds.entries()) {
        const sessionSet = yield* decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.session.set",
            commandId: CommandId.make(`command-session-running-${index + 1}`),
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "full-access",
              activeTurnId: TurnId.make(`turn-cancel-${index + 1}`),
              lastError: null,
              updatedAt: now,
            },
            createdAt: now,
          },
        });
        sequence += 1;
        readModel = yield* projectEvent(readModel, {
          ...(Array.isArray(sessionSet) ? sessionSet[0]! : sessionSet),
          sequence,
        });
      }

      const cancelled = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "task.run.cancel",
          commandId: CommandId.make("command-run-cancel"),
          taskId,
          runId,
          createdAt: now,
        },
      });
      const events = Array.isArray(cancelled) ? cancelled : [cancelled];
      expect(events.map((event) => event.type)).toEqual([
        "task.run-status-changed",
        "thread.turn-interrupt-requested",
        "thread.session-stop-requested",
        "thread.turn-interrupt-requested",
        "thread.session-stop-requested",
      ]);
      const status = events[0];
      expect(status?.type).toBe("task.run-status-changed");
      if (status?.type === "task.run-status-changed") {
        expect(status.payload.status).toBe("cancel-requested");
      }
    }),
  );

  it.effect("moves a settled run through review-ready and cleaned states", () =>
    Effect.gen(function* () {
      let readModel = yield* seedReadModel;
      const runId = TaskRunId.make("run-review");
      const started = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "task.run.start",
          commandId: CommandId.make("command-run-review-start"),
          taskId,
          runId,
          sourceThreadId,
          title: "Review test",
          instructions: "",
          projectCwd: "/tmp/handoff",
          baseBranch: "main",
          workers: [1, 2].map((index) => ({
            threadId: ThreadId.make(`thread-review-${index}`),
            messageId: MessageId.make(`message-review-${index}`),
            label: `Worker ${index}`,
            title: `Worker ${index}`,
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.4",
            },
            runtimeMode: "full-access" as const,
            interactionMode: "default" as const,
            branch: `ethereal/run/${runId}/${index}-worker`,
            worktreePath: `/tmp/worktrees/review-${index}`,
            instructions: "",
          })),
          createdAt: now,
        },
      });
      let sequence = readModel.snapshotSequence;
      for (const event of Array.isArray(started) ? started : [started]) {
        sequence += 1;
        readModel = yield* projectEvent(readModel, { ...event, sequence });
      }

      const reviewReady = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "task.run.mark-review-ready",
          commandId: CommandId.make("command-run-review-ready"),
          taskId,
          runId,
          createdAt: now,
        },
      });
      const reviewEvents = Array.isArray(reviewReady) ? reviewReady : [reviewReady];
      expect(reviewEvents.map((event) => event.type)).toEqual(["task.run-status-changed"]);
      sequence += 1;
      readModel = yield* projectEvent(readModel, { ...reviewEvents[0]!, sequence });
      expect(readModel.tasks[0]?.runs[0]?.status).toBe("review-ready");

      const cleaned = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "task.run.cleanup",
          commandId: CommandId.make("command-run-cleanup"),
          taskId,
          runId,
          createdAt: now,
        },
      });
      if (!Array.isArray(cleaned)) throw new Error("Expected cleanup to emit an event sequence");
      expect(cleaned.map((event) => event.type)).toEqual([
        "task.run-status-changed",
        "thread.meta-updated",
        "thread.meta-updated",
      ]);
      for (const event of cleaned) {
        sequence += 1;
        readModel = yield* projectEvent(readModel, { ...event, sequence });
      }
      expect(readModel.tasks[0]?.runs[0]?.status).toBe("cleaned");
      expect(
        readModel.threads
          .filter((thread) => thread.taskId === taskId && thread.id !== sourceThreadId)
          .map((thread) => thread.worktreePath),
      ).toEqual([null, null]);
    }),
  );
});
