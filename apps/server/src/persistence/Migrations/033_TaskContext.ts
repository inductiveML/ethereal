import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_tasks (
      task_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      goal TEXT NOT NULL,
      context TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  yield* sql`ALTER TABLE projection_threads ADD COLUMN task_id TEXT`;

  yield* sql`
    UPDATE projection_threads
    SET task_id = 'legacy-' || thread_id
    WHERE task_id IS NULL
  `;

  yield* sql`
    INSERT OR IGNORE INTO projection_tasks (
      task_id,
      project_id,
      title,
      goal,
      context,
      created_at,
      updated_at,
      deleted_at
    )
    SELECT
      task_id,
      project_id,
      title,
      '',
      '',
      created_at,
      updated_at,
      deleted_at
    FROM projection_threads
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_tasks_project_created
    ON projection_tasks(project_id, created_at, task_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_task_created
    ON projection_threads(task_id, created_at, thread_id)
  `;
});
