import type {
  OrchestrationTaskRun,
  OrchestrationTaskRunStatus,
  TaskRunId,
} from "@t3tools/contracts";

export const MAX_RETAINED_TASK_RUNS = 100;

export function appendRetainedTaskRun(
  runs: ReadonlyArray<OrchestrationTaskRun>,
  run: OrchestrationTaskRun,
): OrchestrationTaskRun[] {
  return [...runs, run].slice(-MAX_RETAINED_TASK_RUNS);
}

export function updateRetainedTaskRunStatus(
  runs: ReadonlyArray<OrchestrationTaskRun>,
  runId: TaskRunId,
  status: OrchestrationTaskRunStatus,
  statusChangedAt: OrchestrationTaskRun["createdAt"],
): OrchestrationTaskRun[] {
  return runs.map((run) =>
    run.id === runId
      ? {
          ...run,
          status,
          statusChangedAt,
        }
      : run,
  );
}
