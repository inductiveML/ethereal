import {
  ProviderInstanceId,
  type ModelSelection,
  type OrchestrationTaskShell,
  type OrchestrationThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";
import { GitForkIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";

import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

export interface TaskRunStartInput {
  readonly title: string;
  readonly instructions: string;
  readonly workers: ReadonlyArray<{
    readonly label: string;
    readonly modelSelection: ModelSelection;
    readonly instructions: string;
  }>;
}

interface RunWorkerDraft {
  readonly id: string;
  readonly label: string;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly instructions: string;
}

function initialRunWorkers(providers: ReadonlyArray<ServerProvider>): RunWorkerDraft[] {
  return [0, 1].map((index) => {
    const provider = providers[index] ?? providers[0];
    return {
      id: `worker-${index + 1}`,
      label: `Worker ${index + 1}`,
      instanceId: provider?.instanceId ?? ProviderInstanceId.make("codex"),
      model: provider?.models[0]?.slug ?? "",
      instructions: "",
    };
  });
}

export const TaskRunsPanel = memo(function TaskRunsPanel({
  task,
  sessions,
  providers,
  disabled,
  onStartRun,
}: {
  readonly task: OrchestrationTaskShell;
  readonly sessions: ReadonlyArray<OrchestrationThreadShell>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly disabled: boolean;
  readonly onStartRun: (input: TaskRunStartInput) => Promise<boolean>;
}) {
  const [runTitle, setRunTitle] = useState(`${task.title} parallel run`);
  const [runInstructions, setRunInstructions] = useState("");
  const [runWorkers, setRunWorkers] = useState<RunWorkerDraft[]>(() =>
    initialRunWorkers(providers),
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => setRunTitle(`${task.title} parallel run`), [task.title]);

  useEffect(() => {
    if (providers.length === 0) return;
    setRunWorkers((workers) =>
      workers.map((worker, index) => {
        const provider =
          providers.find((candidate) => candidate.instanceId === worker.instanceId) ??
          providers[index] ??
          providers[0]!;
        return {
          ...worker,
          instanceId: provider.instanceId,
          model: provider.models.some((candidate) => candidate.slug === worker.model)
            ? worker.model
            : (provider.models[0]?.slug ?? ""),
        };
      }),
    );
  }, [providers]);

  const startRun = async () => {
    if (runTitle.trim().length === 0) return;
    const workers = runWorkers.flatMap((worker) => {
      const provider = providers.find((candidate) => candidate.instanceId === worker.instanceId);
      return provider && worker.model
        ? [
            {
              label: worker.label,
              modelSelection: { instanceId: provider.instanceId, model: worker.model },
              instructions: worker.instructions,
            },
          ]
        : [];
    });
    if (workers.length !== runWorkers.length) return;
    setBusy(true);
    try {
      const succeeded = await onStartRun({
        title: runTitle.trim(),
        instructions: runInstructions,
        workers,
      });
      if (succeeded) {
        setRunInstructions("");
        setRunWorkers((current) => current.map((worker) => ({ ...worker, instructions: "" })));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {task.runs.length > 0 ? (
        <div className="space-y-2">
          <span className="text-sm font-medium">Runs</span>
          <div className="space-y-2">
            {task.runs
              .toReversed()
              .slice(0, 3)
              .map((run) => (
                <div className="rounded-lg border border-border p-3" key={run.id}>
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate font-medium">{run.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {run.workers.length} workers
                    </span>
                  </div>
                  <div className="mt-2 space-y-1">
                    {run.workers.map((worker) => {
                      const session = sessions.find(
                        (candidate) => candidate.id === worker.threadId,
                      );
                      const status =
                        session?.session?.status ?? session?.latestTurn?.state ?? "preparing";
                      return (
                        <div
                          className="flex items-center justify-between gap-3 text-xs"
                          key={worker.threadId}
                          title={worker.worktreePath}
                        >
                          <span className="min-w-0 truncate">
                            {worker.label} · {worker.branch}
                          </span>
                          <span className="shrink-0 text-muted-foreground">{status}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
          </div>
        </div>
      ) : null}
      <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-4">
        <div>
          <div className="text-sm font-medium">Parallel isolated run</div>
          <div className="text-xs text-muted-foreground">
            Start two agents concurrently. Each receives canonical task context and its own Git
            worktree.
          </div>
        </div>
        <label className="block space-y-1 text-xs text-muted-foreground">
          Run title
          <input
            className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={runTitle}
            onChange={(event) => setRunTitle(event.target.value)}
          />
        </label>
        <Textarea
          placeholder="Shared brief for every worker."
          size="sm"
          value={runInstructions}
          onChange={(event) => setRunInstructions(event.target.value)}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          {runWorkers.map((worker, index) => {
            const provider =
              providers.find((candidate) => candidate.instanceId === worker.instanceId) ??
              providers[0];
            return (
              <div
                className="space-y-2 rounded-lg border border-border bg-background p-3"
                key={worker.id}
              >
                <input
                  aria-label={`Worker ${index + 1} label`}
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={worker.label}
                  onChange={(event) =>
                    setRunWorkers((current) =>
                      current.map((candidate, candidateIndex) =>
                        candidateIndex === index
                          ? { ...candidate, label: event.target.value }
                          : candidate,
                      ),
                    )
                  }
                />
                <select
                  aria-label={`Worker ${index + 1} provider`}
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={provider?.instanceId ?? ""}
                  onChange={(event) => {
                    const nextProvider = providers.find(
                      (candidate) => candidate.instanceId === event.target.value,
                    );
                    if (!nextProvider) return;
                    setRunWorkers((current) =>
                      current.map((candidate, candidateIndex) =>
                        candidateIndex === index
                          ? {
                              ...candidate,
                              instanceId: nextProvider.instanceId,
                              model: nextProvider.models[0]?.slug ?? "",
                            }
                          : candidate,
                      ),
                    );
                  }}
                >
                  {providers.map((candidate) => (
                    <option key={candidate.instanceId} value={candidate.instanceId}>
                      {candidate.displayName}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`Worker ${index + 1} model`}
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={worker.model}
                  onChange={(event) =>
                    setRunWorkers((current) =>
                      current.map((candidate, candidateIndex) =>
                        candidateIndex === index
                          ? { ...candidate, model: event.target.value }
                          : candidate,
                      ),
                    )
                  }
                >
                  {(provider?.models ?? []).map((candidate) => (
                    <option key={candidate.slug} value={candidate.slug}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
                <Textarea
                  placeholder="Worker-specific role or instructions."
                  size="sm"
                  value={worker.instructions}
                  onChange={(event) =>
                    setRunWorkers((current) =>
                      current.map((candidate, candidateIndex) =>
                        candidateIndex === index
                          ? { ...candidate, instructions: event.target.value }
                          : candidate,
                      ),
                    )
                  }
                />
              </div>
            );
          })}
        </div>
        <Button
          className="w-full sm:w-auto"
          disabled={
            disabled ||
            busy ||
            providers.length === 0 ||
            runTitle.trim().length === 0 ||
            runWorkers.some((worker) => worker.label.trim().length === 0 || !worker.model)
          }
          onClick={() => void startRun()}
          variant="secondary"
        >
          Start isolated run <GitForkIcon />
        </Button>
      </div>
    </>
  );
});
