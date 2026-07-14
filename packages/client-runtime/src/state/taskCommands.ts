import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  type CreateTaskInput,
  type DeleteTaskInput,
  type StartTaskHandoffInput,
  type StartTaskRunInput,
  type UpdateTaskContextInput,
  createTask,
  deleteTask,
  startTaskHandoff,
  startTaskRun,
  updateTaskContext,
} from "../operations/commands.ts";
import { createAtomCommandScheduler, createEnvironmentCommand } from "./runtime.ts";

export type {
  CreateTaskInput,
  DeleteTaskInput,
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
  };
}
