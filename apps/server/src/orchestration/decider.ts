import {
  EventId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  listThreadsByProjectId,
  requireProject,
  requireProjectAbsent,
  requireTask,
  requireTaskAbsent,
  requireThread,
  requireThreadArchived,
  requireThreadAbsent,
  requireThreadNotArchived,
} from "./commandInvariants.ts";
import { projectEvent } from "./projector.ts";
import { buildTaskHandoffPrompt } from "./taskHandoff.ts";
import { legacyTaskIdForThread } from "./taskIds.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Effect.Effect<
  Omit<OrchestrationEvent, "sequence" | "type" | "payload">,
  PlatformError.PlatformError,
  Crypto.Crypto
> {
  return Crypto.Crypto.pipe(
    Effect.flatMap((crypto) =>
      crypto.randomUUIDv4.pipe(
        Effect.map((eventId) => ({
          eventId: EventId.make(eventId),
          aggregateKind: input.aggregateKind,
          aggregateId: input.aggregateId,
          occurredAt: input.occurredAt,
          commandId: input.commandId,
          causationEventId: null,
          correlationId: input.commandId,
          metadata: input.metadata ?? {},
        })),
      ),
    ),
  );
}

type PlannedOrchestrationEvent = Omit<OrchestrationEvent, "sequence">;

type DecideOrchestrationCommandResult =
  | PlannedOrchestrationEvent
  | ReadonlyArray<PlannedOrchestrationEvent>;

const decideCommandSequence = Effect.fn("decideCommandSequence")(function* ({
  commands,
  readModel,
}: {
  readonly commands: ReadonlyArray<OrchestrationCommand>;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  ReadonlyArray<PlannedOrchestrationEvent>,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  let nextReadModel = readModel;
  let nextSequence = readModel.snapshotSequence;
  const plannedEvents: PlannedOrchestrationEvent[] = [];

  for (const nextCommand of commands) {
    const decided = yield* decideOrchestrationCommand({
      command: nextCommand,
      readModel: nextReadModel,
    });
    const nextEvents = Array.isArray(decided) ? decided : [decided];
    for (const nextEvent of nextEvents) {
      plannedEvents.push(nextEvent);
      nextSequence += 1;
      nextReadModel = yield* projectEvent(nextReadModel, {
        ...nextEvent,
        sequence: nextSequence,
      }).pipe(Effect.orDie);
    }
  }

  return plannedEvents;
});

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  DecideOrchestrationCommandResult,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });

      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: command.defaultModelSelection ?? null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const activeThreads = listThreadsByProjectId(readModel, command.projectId).filter(
        (thread) => thread.deletedAt === null,
      );
      if (activeThreads.length > 0 && command.force !== true) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' is not empty and cannot be deleted without force=true.`,
        });
      }
      if (activeThreads.length > 0) {
        return yield* decideCommandSequence({
          readModel,
          commands: [
            ...activeThreads.map(
              (thread): Extract<OrchestrationCommand, { type: "thread.delete" }> => ({
                type: "thread.delete",
                commandId: command.commandId,
                threadId: thread.id,
              }),
            ),
            {
              type: "project.delete",
              commandId: command.commandId,
              projectId: command.projectId,
            },
          ],
        });
      }

      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.deleted" as const,
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "task.create": {
      yield* requireProject({ readModel, command, projectId: command.projectId });
      yield* requireTaskAbsent({ readModel, command, taskId: command.taskId });
      return {
        ...(yield* withEventBase({
          aggregateKind: "task",
          aggregateId: command.taskId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "task.created",
        payload: {
          taskId: command.taskId,
          projectId: command.projectId,
          title: command.title,
          goal: command.goal,
          context: command.context,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "task.context.update": {
      yield* requireTask({ readModel, command, taskId: command.taskId });
      if (
        command.title === undefined &&
        command.goal === undefined &&
        command.context === undefined
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Task context update must change title, goal, or context.",
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "task",
          aggregateId: command.taskId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "task.context-updated",
        payload: {
          taskId: command.taskId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.goal !== undefined ? { goal: command.goal } : {}),
          ...(command.context !== undefined ? { context: command.context } : {}),
          updatedAt: command.createdAt,
        },
      };
    }

    case "task.delete": {
      const task = yield* requireTask({ readModel, command, taskId: command.taskId });
      const activeSessions = task.sessionThreadIds
        .map((threadId) => readModel.threads.find((thread) => thread.id === threadId))
        .filter((thread) => thread !== undefined && thread.deletedAt === null);
      if (activeSessions.length > 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Task '${command.taskId}' still has active sessions.`,
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "task",
          aggregateId: command.taskId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "task.deleted",
        payload: { taskId: command.taskId, deletedAt: command.createdAt },
      };
    }

    case "task.handoff.start": {
      const task = yield* requireTask({ readModel, command, taskId: command.taskId });
      const sourceThread = yield* requireThread({
        readModel,
        command,
        threadId: command.sourceThreadId,
      });
      if (!task.sessionThreadIds.includes(sourceThread.id)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${sourceThread.id}' is not a session of task '${task.id}'.`,
        });
      }
      const message = buildTaskHandoffPrompt({
        task,
        sourceThread,
        ...(command.instructions !== undefined ? { instructions: command.instructions } : {}),
      });
      return yield* decideCommandSequence({
        readModel,
        commands: [
          {
            type: "thread.create",
            commandId: command.commandId,
            threadId: command.targetThreadId,
            projectId: task.projectId,
            taskId: task.id,
            title: command.title,
            modelSelection: command.modelSelection,
            runtimeMode: command.runtimeMode,
            interactionMode: command.interactionMode,
            branch: command.branch,
            worktreePath: command.worktreePath,
            createdAt: command.createdAt,
          },
          {
            type: "thread.turn.start",
            commandId: command.commandId,
            threadId: command.targetThreadId,
            message: {
              messageId: command.messageId,
              role: "user",
              text: message,
              attachments: [],
            },
            modelSelection: command.modelSelection,
            titleSeed: command.title,
            runtimeMode: command.runtimeMode,
            interactionMode: command.interactionMode,
            createdAt: command.createdAt,
          },
        ],
      });
    }

    case "task.run.start": {
      const task = yield* requireTask({ readModel, command, taskId: command.taskId });
      const project = yield* requireProject({ readModel, command, projectId: task.projectId });
      const sourceThread = yield* requireThread({
        readModel,
        command,
        threadId: command.sourceThreadId,
      });
      if (!task.sessionThreadIds.includes(sourceThread.id)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${sourceThread.id}' is not a session of task '${task.id}'.`,
        });
      }
      if (project.workspaceRoot !== command.projectCwd) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Run workspace '${command.projectCwd}' does not match task project '${project.workspaceRoot}'.`,
        });
      }
      if (task.runs.some((run) => run.id === command.runId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Run '${command.runId}' already exists on task '${task.id}'.`,
        });
      }
      const uniqueThreadIds = new Set(command.workers.map((worker) => worker.threadId));
      const uniqueMessageIds = new Set(command.workers.map((worker) => worker.messageId));
      const uniqueBranches = new Set(command.workers.map((worker) => worker.branch));
      if (
        uniqueThreadIds.size !== command.workers.length ||
        uniqueMessageIds.size !== command.workers.length ||
        uniqueBranches.size !== command.workers.length
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Parallel run workers must use unique thread, message, and branch identifiers.",
        });
      }
      const runBranchPrefix = `ethereal/run/${command.runId}/`;
      if (command.workers.some((worker) => !worker.branch.startsWith(runBranchPrefix))) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Parallel run branches must start with '${runBranchPrefix}'.`,
        });
      }
      if (command.workers.some((worker) => worker.worktreePath === null)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Parallel run workers must be assigned isolated worktrees before dispatch.",
        });
      }

      const runEvent: Omit<
        Extract<OrchestrationEvent, { type: "task.run-started" }>,
        "sequence"
      > = {
        ...(yield* withEventBase({
          aggregateKind: "task",
          aggregateId: task.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "task.run-started",
        payload: {
          taskId: task.id,
          run: {
            id: command.runId,
            title: command.title,
            sourceThreadId: sourceThread.id,
            instructions: command.instructions,
            workers: command.workers.map((worker) => ({
              threadId: worker.threadId,
              label: worker.label,
              modelSelection: worker.modelSelection,
              branch: worker.branch,
              worktreePath: worker.worktreePath!,
            })),
            status: "active",
            statusChangedAt: null,
            createdAt: command.createdAt,
          },
          updatedAt: command.createdAt,
        },
      };
      const readModelWithRun = yield* projectEvent(readModel, {
        ...runEvent,
        sequence: readModel.snapshotSequence + 1,
      }).pipe(Effect.orDie);
      const workerCommands = command.workers.flatMap((worker): OrchestrationCommand[] => {
        const materializedInstructions = [
          `Parallel run: ${command.title}`,
          command.instructions.trim(),
          `Assigned worker: ${worker.label}`,
          worker.instructions.trim(),
          "Work independently in the assigned isolated Git worktree. Inspect the repository state before editing and report the concrete outcome and validation results.",
        ]
          .filter((part) => part.length > 0)
          .join("\n\n");
        const message = buildTaskHandoffPrompt({
          task,
          sourceThread,
          instructions: materializedInstructions,
        });
        return [
          {
            type: "thread.create",
            commandId: command.commandId,
            threadId: worker.threadId,
            projectId: task.projectId,
            taskId: task.id,
            title: worker.title,
            modelSelection: worker.modelSelection,
            runtimeMode: worker.runtimeMode,
            interactionMode: worker.interactionMode,
            branch: worker.branch,
            worktreePath: worker.worktreePath,
            createdAt: command.createdAt,
          },
          {
            type: "thread.turn.start",
            commandId: command.commandId,
            threadId: worker.threadId,
            message: {
              messageId: worker.messageId,
              role: "user",
              text: message,
              attachments: [],
            },
            modelSelection: worker.modelSelection,
            titleSeed: worker.title,
            runtimeMode: worker.runtimeMode,
            interactionMode: worker.interactionMode,
            createdAt: command.createdAt,
          },
        ];
      });
      return [
        runEvent,
        ...(yield* decideCommandSequence({
          readModel: readModelWithRun,
          commands: workerCommands,
        })),
      ];
    }

    case "task.run.cancel": {
      const task = yield* requireTask({ readModel, command, taskId: command.taskId });
      const run = task.runs.find((candidate) => candidate.id === command.runId);
      if (!run) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Run '${command.runId}' does not exist on task '${task.id}'.`,
        });
      }
      if (run.status !== "active") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Run '${run.id}' cannot be cancelled from status '${run.status}'.`,
        });
      }

      const statusEvent: Omit<
        Extract<OrchestrationEvent, { type: "task.run-status-changed" }>,
        "sequence"
      > = {
        ...(yield* withEventBase({
          aggregateKind: "task",
          aggregateId: task.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "task.run-status-changed",
        payload: {
          taskId: task.id,
          runId: run.id,
          status: "cancel-requested",
          updatedAt: command.createdAt,
        },
      };
      const readModelWithStatus = yield* projectEvent(readModel, {
        ...statusEvent,
        sequence: readModel.snapshotSequence + 1,
      }).pipe(Effect.orDie);
      const workerCommands = run.workers.flatMap((worker): OrchestrationCommand[] => {
        const thread = readModel.threads.find((candidate) => candidate.id === worker.threadId);
        if (!thread) return [];
        return [
          ...(thread.latestTurn?.state === "running"
            ? [
                {
                  type: "thread.turn.interrupt" as const,
                  commandId: command.commandId,
                  threadId: thread.id,
                  turnId: thread.latestTurn.turnId,
                  createdAt: command.createdAt,
                },
              ]
            : []),
          ...(thread.session !== null && thread.session.status !== "stopped"
            ? [
                {
                  type: "thread.session.stop" as const,
                  commandId: command.commandId,
                  threadId: thread.id,
                  createdAt: command.createdAt,
                },
              ]
            : []),
        ];
      });
      return [
        statusEvent,
        ...(yield* decideCommandSequence({
          readModel: readModelWithStatus,
          commands: workerCommands,
        })),
      ];
    }

    case "task.run.mark-review-ready": {
      const task = yield* requireTask({ readModel, command, taskId: command.taskId });
      const run = task.runs.find((candidate) => candidate.id === command.runId);
      if (!run) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Run '${command.runId}' does not exist on task '${task.id}'.`,
        });
      }
      if (run.status !== "active" && run.status !== "cancel-requested") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Run '${run.id}' cannot be marked review-ready from status '${run.status}'.`,
        });
      }
      const workerThreads = run.workers.map((worker) =>
        readModel.threads.find((candidate) => candidate.id === worker.threadId),
      );
      if (workerThreads.some((thread) => thread === undefined)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Run '${run.id}' has a missing worker thread.`,
        });
      }
      const busyThread = workerThreads.find(
        (thread) =>
          thread?.latestTurn?.state === "running" ||
          thread?.session?.status === "starting" ||
          thread?.session?.status === "running",
      );
      if (busyThread) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Run '${run.id}' still has an active worker '${busyThread.id}'.`,
        });
      }

      const statusEvent: Omit<
        Extract<OrchestrationEvent, { type: "task.run-status-changed" }>,
        "sequence"
      > = {
        ...(yield* withEventBase({
          aggregateKind: "task",
          aggregateId: task.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "task.run-status-changed",
        payload: {
          taskId: task.id,
          runId: run.id,
          status: "review-ready",
          updatedAt: command.createdAt,
        },
      };
      const readModelWithStatus = yield* projectEvent(readModel, {
        ...statusEvent,
        sequence: readModel.snapshotSequence + 1,
      }).pipe(Effect.orDie);
      const stopCommands = workerThreads.flatMap((thread): OrchestrationCommand[] =>
        thread && thread.session !== null && thread.session.status !== "stopped"
          ? [
              {
                type: "thread.session.stop",
                commandId: command.commandId,
                threadId: thread.id,
                createdAt: command.createdAt,
              },
            ]
          : [],
      );
      return [
        statusEvent,
        ...(yield* decideCommandSequence({
          readModel: readModelWithStatus,
          commands: stopCommands,
        })),
      ];
    }

    case "task.run.cleanup": {
      const task = yield* requireTask({ readModel, command, taskId: command.taskId });
      const run = task.runs.find((candidate) => candidate.id === command.runId);
      if (!run) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Run '${command.runId}' does not exist on task '${task.id}'.`,
        });
      }
      if (run.status !== "review-ready" && run.status !== "cancel-requested") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Run '${run.id}' cannot be cleaned from status '${run.status}'.`,
        });
      }
      const workerThreads = run.workers.map((worker) =>
        readModel.threads.find((candidate) => candidate.id === worker.threadId),
      );
      if (workerThreads.some((thread) => thread === undefined)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Run '${run.id}' has a missing worker thread.`,
        });
      }
      const activeThread = workerThreads.find(
        (thread) =>
          thread?.latestTurn?.state === "running" ||
          (thread?.session !== null && thread?.session.status !== "stopped"),
      );
      if (activeThread) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Run '${run.id}' still has an active worker '${activeThread.id}'.`,
        });
      }
      const statusEvent: Omit<
        Extract<OrchestrationEvent, { type: "task.run-status-changed" }>,
        "sequence"
      > = {
        ...(yield* withEventBase({
          aggregateKind: "task",
          aggregateId: task.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "task.run-status-changed",
        payload: {
          taskId: task.id,
          runId: run.id,
          status: "cleaned",
          updatedAt: command.createdAt,
        },
      };
      const readModelWithStatus = yield* projectEvent(readModel, {
        ...statusEvent,
        sequence: readModel.snapshotSequence + 1,
      }).pipe(Effect.orDie);
      return [
        statusEvent,
        ...(yield* decideCommandSequence({
          readModel: readModelWithStatus,
          commands: run.workers.map(
            (worker): OrchestrationCommand => ({
              type: "thread.meta.update",
              commandId: command.commandId,
              threadId: worker.threadId,
              worktreePath: null,
            }),
          ),
        })),
      ];
    }

    case "thread.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      const taskId = command.taskId ?? legacyTaskIdForThread(command.threadId);
      if (command.taskId !== undefined) {
        const task = yield* requireTask({ readModel, command, taskId: command.taskId });
        if (task.projectId !== command.projectId) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Task '${task.id}' belongs to a different project.`,
          });
        }
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          taskId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.delete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.archive": {
      yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.unarchive": {
      yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.meta.update": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const branch =
        command.branch !== undefined &&
        command.expectedBranch !== undefined &&
        thread.branch !== command.expectedBranch
          ? thread.branch
          : command.branch;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(branch !== undefined ? { branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.turn.start": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sourceProposedPlan = command.sourceProposedPlan;
      const sourceThread = sourceProposedPlan
        ? yield* requireThread({
            readModel,
            command,
            threadId: sourceProposedPlan.threadId,
          })
        : null;
      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;
      if (sourceProposedPlan && !sourcePlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        });
      }
      if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
        });
      }
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
          runtimeMode: targetThread.runtimeMode,
          interactionMode: targetThread.interactionMode,
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          createdAt: command.createdAt,
        },
      };
      return [userMessageEvent, turnStartRequestedEvent];
    }

    case "thread.turn.interrupt": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.approval.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.checkpoint.revert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        })),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
    }

    case "thread.message.assistant.delta": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          turnId: command.turnId ?? null,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: "",
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.activity.append": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        })),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
