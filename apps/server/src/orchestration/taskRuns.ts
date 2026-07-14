import type { OrchestrationTaskRun } from "@t3tools/contracts";

export const MAX_RETAINED_TASK_RUNS = 100;

export function appendRetainedTaskRun(
  runs: ReadonlyArray<OrchestrationTaskRun>,
  run: OrchestrationTaskRun,
): OrchestrationTaskRun[] {
  return [...runs, run].slice(-MAX_RETAINED_TASK_RUNS);
}
