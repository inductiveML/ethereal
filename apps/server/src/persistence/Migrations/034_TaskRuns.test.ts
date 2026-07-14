import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("034_TaskRuns", (it) => {
  it.effect("backfills an empty durable run list for existing tasks", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 33 });
      yield* sql`
        INSERT INTO projection_tasks (
          task_id, project_id, title, goal, context, created_at, updated_at, deleted_at
        ) VALUES (
          'task-existing', 'project-existing', 'Existing task', '', '',
          '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z', NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 34 });

      const rows = yield* sql<{ readonly runsJson: string }>`
        SELECT runs_json AS "runsJson" FROM projection_tasks WHERE task_id = 'task-existing'
      `;
      assert.deepStrictEqual(rows, [{ runsJson: "[]" }]);
    }),
  );
});
