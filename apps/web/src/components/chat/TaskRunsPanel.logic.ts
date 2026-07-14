import type {
  OrchestrationTaskRun,
  OrchestrationTaskRunStatus,
  OrchestrationThreadShell,
} from "@t3tools/contracts";

const RUN_STATUS_LABELS: Record<OrchestrationTaskRunStatus, string> = {
  active: "Active",
  "cancel-requested": "Stopping",
  "review-ready": "Review ready",
  cleaned: "Cleaned",
};

export interface TaskRunLifecyclePresentation {
  readonly label: string;
  readonly hasBusyWorker: boolean;
  readonly allWorkersSettled: boolean;
  readonly allSessionsStopped: boolean;
  readonly canCancel: boolean;
  readonly canMarkReviewReady: boolean;
  readonly canCleanup: boolean;
}

export function taskRunLifecyclePresentation(
  run: OrchestrationTaskRun,
  sessions: ReadonlyArray<OrchestrationThreadShell>,
): TaskRunLifecyclePresentation {
  const workerSessions = run.workers.map((worker) =>
    sessions.find((session) => session.id === worker.threadId),
  );
  const isBusy = (session: OrchestrationThreadShell | undefined) =>
    session?.latestTurn?.state === "running" ||
    session?.session?.status === "starting" ||
    session?.session?.status === "running";
  const hasBusyWorker = workerSessions.some(isBusy);
  const allWorkersPresent = workerSessions.every((session) => session !== undefined);
  const allWorkersSettled = allWorkersPresent && !hasBusyWorker;
  const allSessionsStopped =
    allWorkersPresent &&
    workerSessions.every(
      (session) =>
        session?.latestTurn?.state !== "running" &&
        (session?.session === null || session?.session?.status === "stopped"),
    );

  return {
    label: RUN_STATUS_LABELS[run.status],
    hasBusyWorker,
    allWorkersSettled,
    allSessionsStopped,
    canCancel: run.status === "active" && hasBusyWorker,
    canMarkReviewReady:
      (run.status === "active" || run.status === "cancel-requested") && allWorkersSettled,
    canCleanup:
      (run.status === "review-ready" || run.status === "cancel-requested") && allSessionsStopped,
  };
}
