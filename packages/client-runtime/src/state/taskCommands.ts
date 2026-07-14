import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  type CancelTaskRunInput,
  type CleanupTaskRunInput,
  type CreateTaskInput,
  type DeleteTaskInput,
  type MarkTaskRunReviewReadyInput,
  type StartTaskHandoffInput,
  type StartTaskRunInput,
  type UpdateTaskContextInput,
  cancelTaskRun,
  cleanupTaskRun,
  createTask,
  deleteTask,
  markTaskRunReviewReady,
  startTaskHandoff,
  startTaskRun,
  updateTaskContext,
} from "../operations/commands.ts";
import { createAtomCommandScheduler, createEnvironmentCommand } from "./runtime.ts";

export type {
  CancelTaskRunInput,
  CleanupTaskRunInput,
  CreateTaskInput,
  DeleteTaskInput,
  MarkTaskRunReviewReadyInput,
  StartTaskHandoffInput,
  StartTaskRunInput,
  UpdateTaskContextInput,
};

export function createTaskEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { taskId: string } }) =>
      JSON.stringify([environmentId, input.taskId]),
  };
  return {
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task:create",
      execute: createTask,
      scheduler,
      concurrency,
    }),
    updateContext: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task:update-context",
      execute: updateTaskContext,
      scheduler,
      concurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task:delete",
      execute: deleteTask,
      scheduler,
      concurrency,
    }),
    startHandoff: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task:start-handoff",
      execute: startTaskHandoff,
      scheduler,
      concurrency,
    }),
    startRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task:start-run",
      execute: startTaskRun,
      scheduler,
      concurrency,
    }),
    cancelRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task:cancel-run",
      execute: cancelTaskRun,
      scheduler,
      concurrency,
    }),
    markRunReviewReady: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task:mark-run-review-ready",
      execute: markTaskRunReviewReady,
      scheduler,
      concurrency,
    }),
    cleanupRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task:cleanup-run",
      execute: cleanupTaskRun,
      scheduler,
      concurrency,
    }),
  };
}
