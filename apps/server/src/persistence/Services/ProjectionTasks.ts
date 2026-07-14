import { IsoDateTime, OrchestrationTaskRun, ProjectId, TaskId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionTask = Schema.Struct({
  taskId: TaskId,
  projectId: ProjectId,
  title: Schema.String,
  goal: Schema.String,
  context: Schema.String,
  runs: Schema.Array(OrchestrationTaskRun),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionTask = typeof ProjectionTask.Type;

export interface ProjectionTaskRepositoryShape {
  readonly upsert: (task: ProjectionTask) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    taskId: TaskId,
  ) => Effect.Effect<Option.Option<ProjectionTask>, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<ReadonlyArray<ProjectionTask>, ProjectionRepositoryError>;
}

export class ProjectionTaskRepository extends Context.Service<
  ProjectionTaskRepository,
  ProjectionTaskRepositoryShape
>()("t3/persistence/Services/ProjectionTasks/ProjectionTaskRepository") {}
