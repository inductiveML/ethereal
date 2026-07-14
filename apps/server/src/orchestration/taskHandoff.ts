import type { OrchestrationTask, OrchestrationThread } from "@t3tools/contracts";

const MAX_RECENT_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 6_000;
const MAX_CONTEXT_CHARS = 30_000;
const MAX_PLAN_CHARS = 20_000;
const MAX_HANDOFF_PROMPT_CHARS = 100_000;

function bounded(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated by Ethereal]`;
}

function section(title: string, body: string): string | null {
  const trimmed = body.trim();
  return trimmed.length > 0 ? `## ${title}\n\n${trimmed}` : null;
}

/**
 * Materialize provider-neutral handoff context from durable task/session state.
 * The result is deliberately plain Markdown so every coding harness receives
 * the same canonical context without provider-specific prompt semantics.
 */
export function buildTaskHandoffPrompt(input: {
  readonly task: OrchestrationTask;
  readonly sourceThread: OrchestrationThread;
  readonly instructions?: string | undefined;
}): string {
  const { task, sourceThread } = input;
  const messages = sourceThread.messages
    .filter((message) => !message.streaming && message.text.trim().length > 0)
    .slice(-MAX_RECENT_MESSAGES)
    .map((message) => `### ${message.role}\n\n${bounded(message.text.trim(), MAX_MESSAGE_CHARS)}`)
    .join("\n\n");
  const latestPlan = sourceThread.proposedPlans.at(-1)?.planMarkdown ?? "";
  const latestCheckpoint = sourceThread.checkpoints.at(-1);
  const changedFiles = latestCheckpoint
    ? latestCheckpoint.files
        .map((file) => `- ${file.path} (${file.kind}, +${file.additions}/-${file.deletions})`)
        .join("\n")
    : "";

  const sections = [
    "You are continuing an Ethereal task from another coding-agent session. Treat the shared task context below as canonical, inspect the current working tree before changing code, and continue the work without redoing completed steps.",
    section("Task", `**${task.title}**`),
    section("Shared goal", bounded(task.goal, MAX_CONTEXT_CHARS)),
    section("Canonical context", bounded(task.context, MAX_CONTEXT_CHARS)),
    section(
      "Source session",
      [
        `Title: ${sourceThread.title}`,
        `Provider instance: ${sourceThread.modelSelection.instanceId}`,
        `Model: ${sourceThread.modelSelection.model}`,
        sourceThread.branch ? `Branch: ${sourceThread.branch}` : null,
        sourceThread.worktreePath ? `Worktree: ${sourceThread.worktreePath}` : null,
      ]
        .filter((value): value is string => value !== null)
        .join("\n"),
    ),
    section("Recent conversation", messages),
    section("Latest proposed plan", bounded(latestPlan, MAX_PLAN_CHARS)),
    section("Latest changed files", changedFiles),
    section("Handoff instructions", input.instructions ?? ""),
  ].filter((value): value is string => value !== null);

  return bounded(sections.join("\n\n"), MAX_HANDOFF_PROMPT_CHARS);
}
