import {
  ProviderInstanceId,
  TaskRunId,
  TaskId,
  ThreadId,
  TurnId,
  type OrchestrationTaskRun,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { taskRunLifecyclePresentation } from "./TaskRunsPanel.logic";

const now = "2026-07-14T00:00:00.000Z";
const workerThreadId = ThreadId.make("worker-1");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
};

function makeRun(status: OrchestrationTaskRun["status"]): OrchestrationTaskRun {
  return {
    id: TaskRunId.make("run-1"),
    title: "Parallel run",
    sourceThreadId: ThreadId.make("source"),
    instructions: "",
    workers: [
      {
        threadId: workerThreadId,
        label: "Worker 1",
        modelSelection,
        branch: "ethereal/run/run-1/1-worker",
        worktreePath: "/tmp/worker-1",
      },
    ],
    status,
    statusChangedAt: status === "active" ? null : now,
    createdAt: now,
  };
}

function makeSession(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: workerThreadId,
    projectId: "project-1" as OrchestrationThreadShell["projectId"],
    taskId: TaskId.make("task-1"),
    title: "Worker 1",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "ethereal/run/run-1/1-worker",
    worktreePath: "/tmp/worker-1",
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("taskRunLifecyclePresentation", () => {
  it("offers cancellation while a worker is running", () => {
    const session = makeSession({
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        assistantMessageId: null,
      },
    });

    expect(taskRunLifecyclePresentation(makeRun("active"), [session])).toMatchObject({
      label: "Active",
      hasBusyWorker: true,
      canCancel: true,
      canMarkReviewReady: false,
      canCleanup: false,
    });
  });

  it("offers review when workers settle and cleanup only after sessions stop", () => {
    const readySession = makeSession({
      session: {
        threadId: workerThreadId,
        status: "ready",
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      },
    });
    expect(taskRunLifecyclePresentation(makeRun("active"), [readySession])).toMatchObject({
      allWorkersSettled: true,
      allSessionsStopped: false,
      canMarkReviewReady: true,
      canCleanup: false,
    });
    expect(taskRunLifecyclePresentation(makeRun("review-ready"), [makeSession()])).toMatchObject({
      label: "Review ready",
      allSessionsStopped: true,
      canCleanup: true,
    });
  });

  it("does not expose lifecycle actions when a worker thread is missing", () => {
    expect(taskRunLifecyclePresentation(makeRun("active"), [])).toMatchObject({
      allWorkersSettled: false,
      allSessionsStopped: false,
      canCancel: false,
      canMarkReviewReady: false,
      canCleanup: false,
    });
  });
});
