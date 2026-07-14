import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("033_TaskContext", (it) => {
  it.effect("backfills one durable task for every existing thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 32 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at
        )
        VALUES (
          'thread-existing',
          'project-existing',
          'Existing session',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          'full-access',
          'default',
          'main',
          NULL,
          NULL,
          '2026-07-14T00:00:00.000Z',
          '2026-07-14T00:01:00.000Z',
          NULL,
          NULL,
          0,
          0,
          0,
          NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 33 });

      const threadRows = yield* sql<{ readonly taskId: string }>`
        SELECT task_id AS "taskId"
        FROM projection_threads
        WHERE thread_id = 'thread-existing'
      `;
      assert.deepStrictEqual(threadRows, [{ taskId: "legacy-thread-existing" }]);

      const taskRows = yield* sql<{
        readonly taskId: string;
        readonly projectId: string;
        readonly title: string;
        readonly goal: string;
        readonly context: string;
      }>`
        SELECT
          task_id AS "taskId",
          project_id AS "projectId",
          title,
          goal,
          context
        FROM projection_tasks
        WHERE task_id = 'legacy-thread-existing'
      `;
      assert.deepStrictEqual(taskRows, [
        {
          taskId: "legacy-thread-existing",
          projectId: "project-existing",
          title: "Existing session",
          goal: "",
          context: "",
        },
      ]);
    }),
  );
});
