import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionTask,
  ProjectionTaskRepository,
  type ProjectionTaskRepositoryShape,
} from "../Services/ProjectionTasks.ts";
import { TaskId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const TaskLookup = Schema.Struct({ taskId: TaskId });

const makeProjectionTaskRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const upsertRow = SqlSchema.void({
    Request: ProjectionTask,
    execute: (row) => sql`
      INSERT INTO projection_tasks (
        task_id, project_id, title, goal, context, created_at, updated_at, deleted_at
      ) VALUES (
        ${row.taskId}, ${row.projectId}, ${row.title}, ${row.goal}, ${row.context},
        ${row.createdAt}, ${row.updatedAt}, ${row.deletedAt}
      )
      ON CONFLICT (task_id) DO UPDATE SET
        project_id = excluded.project_id,
        title = excluded.title,
        goal = excluded.goal,
        context = excluded.context,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
    `,
  });
  const getRow = SqlSchema.findOneOption({
    Request: TaskLookup,
    Result: ProjectionTask,
    execute: ({ taskId }) => sql`
      SELECT task_id AS "taskId", project_id AS "projectId", title, goal, context,
        created_at AS "createdAt", updated_at AS "updatedAt", deleted_at AS "deletedAt"
      FROM projection_tasks WHERE task_id = ${taskId}
    `,
  });
  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionTask,
    execute: () => sql`
      SELECT task_id AS "taskId", project_id AS "projectId", title, goal, context,
        created_at AS "createdAt", updated_at AS "updatedAt", deleted_at AS "deletedAt"
      FROM projection_tasks ORDER BY created_at ASC, task_id ASC
    `,
  });

  return {
    upsert: (row) =>
      upsertRow(row).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionTaskRepository.upsert:query")),
      ),
    getById: (taskId) =>
      getRow({ taskId }).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionTaskRepository.getById:query")),
      ),
    listAll: () =>
      listRows(undefined).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionTaskRepository.listAll:query")),
      ),
  } satisfies ProjectionTaskRepositoryShape;
});

export const ProjectionTaskRepositoryLive = Layer.effect(
  ProjectionTaskRepository,
  makeProjectionTaskRepository,
);
