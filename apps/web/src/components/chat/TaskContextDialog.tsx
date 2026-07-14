import {
  ProviderInstanceId,
  type ModelSelection,
  type OrchestrationTaskShell,
  type OrchestrationThreadShell,
  type ServerProvider,
  type TaskRunId,
} from "@t3tools/contracts";
import { ArrowRightIcon, ClipboardListIcon } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TaskRunsPanel, type TaskRunStartInput } from "./TaskRunsPanel";

interface TaskContextDialogProps {
  readonly task: OrchestrationTaskShell;
  readonly sessions: ReadonlyArray<OrchestrationThreadShell>;
  readonly activeThreadId: OrchestrationThreadShell["id"];
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly disabled?: boolean;
  readonly onSave: (input: {
    readonly title: string;
    readonly goal: string;
    readonly context: string;
  }) => Promise<boolean>;
  readonly onHandoff: (input: {
    readonly modelSelection: ModelSelection;
    readonly instructions: string;
  }) => Promise<boolean>;
  readonly onStartRun: (input: TaskRunStartInput) => Promise<boolean>;
  readonly onCancelRun: (runId: TaskRunId) => Promise<boolean>;
  readonly onMarkRunReviewReady: (runId: TaskRunId) => Promise<boolean>;
  readonly onCleanupRun: (runId: TaskRunId) => Promise<boolean>;
}

function selectableProviders(providers: ReadonlyArray<ServerProvider>) {
  return providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      provider.status === "ready" &&
      provider.availability !== "unavailable" &&
      provider.models.length > 0,
  );
}

export const TaskContextDialog = memo(function TaskContextDialog({
  task,
  sessions,
  activeThreadId,
  providers,
  disabled = false,
  onSave,
  onHandoff,
  onStartRun,
  onCancelRun,
  onMarkRunReviewReady,
  onCleanupRun,
}: TaskContextDialogProps) {
  const availableProviders = useMemo(() => selectableProviders(providers), [providers]);
  const defaultProvider =
    availableProviders.find(
      (provider) =>
        !sessions.some(
          (session) =>
            session.id === activeThreadId &&
            session.modelSelection.instanceId === provider.instanceId,
        ),
    ) ?? availableProviders[0];
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [goal, setGoal] = useState(task.goal);
  const [context, setContext] = useState(task.context);
  const [instructions, setInstructions] = useState("");
  const [instanceId, setInstanceId] = useState<ProviderInstanceId>(
    defaultProvider?.instanceId ?? ProviderInstanceId.make("codex"),
  );
  const selectedProvider =
    availableProviders.find((provider) => provider.instanceId === instanceId) ?? defaultProvider;
  const [model, setModel] = useState(selectedProvider?.models[0]?.slug ?? "");
  const [busy, setBusy] = useState<"save" | "handoff" | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(task.title);
    setGoal(task.goal);
    setContext(task.context);
  }, [open, task.context, task.goal, task.title]);

  useEffect(() => {
    const provider =
      availableProviders.find((candidate) => candidate.instanceId === instanceId) ??
      availableProviders[0];
    if (!provider) return;
    if (provider.instanceId !== instanceId) setInstanceId(provider.instanceId);
    if (!provider.models.some((candidate) => candidate.slug === model)) {
      setModel(provider.models[0]?.slug ?? "");
    }
  }, [availableProviders, instanceId, model]);

  const save = async () => {
    const nextTitle = title.trim();
    if (!nextTitle) return;
    setBusy("save");
    const succeeded = await onSave({ title: nextTitle, goal, context });
    setBusy(null);
    if (succeeded) setOpen(false);
  };

  const handoff = async () => {
    if (!selectedProvider || !model) return;
    setBusy("handoff");
    const succeeded = await onHandoff({
      modelSelection: { instanceId: selectedProvider.instanceId, model },
      instructions,
    });
    setBusy(null);
    if (succeeded) setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <DialogTrigger
              render={
                <Button
                  aria-label="Task context and handoff"
                  disabled={disabled}
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <ClipboardListIcon />
            </DialogTrigger>
          }
        />
        <TooltipPopup side="bottom">Task context and handoff</TooltipPopup>
      </Tooltip>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Task context</DialogTitle>
          <DialogDescription>
            Shared context stays above provider sessions and follows handoffs.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">Title</span>
            <input
              className="h-9 w-full rounded-lg border border-input bg-background px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">Shared goal</span>
            <Textarea
              placeholder="What must this task accomplish?"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
            />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">Canonical context</span>
            <Textarea
              className="min-h-28"
              placeholder="Decisions, constraints, important files, and test results."
              value={context}
              onChange={(event) => setContext(event.target.value)}
            />
          </label>
          <div className="space-y-2">
            <span className="text-sm font-medium">Sessions</span>
            <div className="space-y-1 rounded-lg border border-border p-2">
              {sessions.map((session) => (
                <div
                  className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm"
                  key={session.id}
                >
                  <span className="min-w-0 truncate">
                    {session.title}
                    {session.id === activeThreadId ? " · current" : ""}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {session.modelSelection.instanceId} / {session.modelSelection.model}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <TaskRunsPanel
            disabled={busy !== null}
            onCancelRun={onCancelRun}
            onCleanupRun={onCleanupRun}
            onMarkReviewReady={onMarkRunReviewReady}
            onStartRun={onStartRun}
            providers={availableProviders}
            sessions={sessions}
            task={task}
          />
          <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-4">
            <div>
              <div className="text-sm font-medium">Hand off to another agent</div>
              <div className="text-xs text-muted-foreground">
                Ethereal will materialize the shared task, recent conversation, plan, and changed
                files into the new session.
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="space-y-1 text-xs text-muted-foreground">
                Provider
                <select
                  className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground"
                  value={selectedProvider?.instanceId ?? ""}
                  onChange={(event) => setInstanceId(event.target.value as ProviderInstanceId)}
                >
                  {availableProviders.map((provider) => (
                    <option key={provider.instanceId} value={provider.instanceId}>
                      {provider.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-xs text-muted-foreground">
                Model
                <select
                  className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                >
                  {(selectedProvider?.models ?? []).map((candidate) => (
                    <option key={candidate.slug} value={candidate.slug}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <Textarea
              placeholder="Optional instructions for the receiving agent."
              size="sm"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
            <Button
              className="w-full sm:w-auto"
              disabled={busy !== null || !selectedProvider || !model}
              onClick={() => void handoff()}
              variant="secondary"
            >
              Hand off <ArrowRightIcon />
            </Button>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button disabled={busy !== null || title.trim().length === 0} onClick={() => void save()}>
            Save context
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
});
