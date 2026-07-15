import {
  ProviderInstanceId,
  type ModelSelection,
  type OrchestrationTaskShell,
  type OrchestrationThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";
import { ArrowRightIcon, ClipboardListIcon, XIcon } from "lucide-react";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

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
      <DialogPopup className="max-w-2xl" showCloseButton={false}>
        <Button
          aria-label="Close task context"
          className="absolute end-3 top-3 z-10"
          onClick={() => setOpen(false)}
          size="icon-sm"
          variant="ghost"
        >
          <XIcon />
        </Button>
        <DialogHeader>
          <DialogTitle>Task context</DialogTitle>
          <DialogDescription>
            A project is the workspace. Each conversation has its own task; its shared goal and
            context follow only agent sessions created through handoff.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-6">
          <label className="flex flex-col gap-2 text-sm">
            <span className="font-medium">Title</span>
            <input
              className="h-9 w-full rounded-lg border border-input bg-background px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-2 text-sm">
            <span className="font-medium">Shared goal</span>
            <Textarea
              placeholder="What must this task accomplish?"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-2 text-sm">
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
          <div className="space-y-4 rounded-xl border border-border bg-muted/30 p-4">
            <div className="space-y-1">
              <div className="text-sm font-medium">Hand off to another agent</div>
              <div className="text-xs text-muted-foreground">
                Ethereal will materialize the shared task, recent conversation, plan, and changed
                files into the new session.
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-2 text-xs text-muted-foreground">
                <span>Provider</span>
                <Select
                  value={selectedProvider?.instanceId ?? ""}
                  onValueChange={(value) => {
                    if (value) setInstanceId(value as ProviderInstanceId);
                  }}
                >
                  <SelectTrigger aria-label="Handoff provider" className="w-full">
                    <SelectValue>{selectedProvider?.displayName ?? "Choose provider"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {availableProviders.map((provider) => (
                      <SelectItem
                        hideIndicator
                        key={provider.instanceId}
                        value={provider.instanceId}
                      >
                        {provider.displayName}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <div className="flex flex-col gap-2 text-xs text-muted-foreground">
                <span>Model</span>
                <Select value={model} onValueChange={(value) => value && setModel(value)}>
                  <SelectTrigger aria-label="Handoff model" className="w-full">
                    <SelectValue>
                      {selectedProvider?.models.find((candidate) => candidate.slug === model)
                        ?.name ?? "Choose model"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {(selectedProvider?.models ?? []).map((candidate) => (
                      <SelectItem hideIndicator key={candidate.slug} value={candidate.slug}>
                        {candidate.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
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
