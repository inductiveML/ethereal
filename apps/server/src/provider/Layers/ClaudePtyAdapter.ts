import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  type ClaudeSettings,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderInteractionMode,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as PtyAdapter from "../../terminal/PtyAdapter.ts";
import { makeClaudeEnvironment, resolveClaudeHomePath } from "../Drivers/ClaudeHome.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  startClaudeHookServer,
  type ClaudeHookInput,
  type ClaudeHookResponse,
  type ClaudeHookServer,
  type ClaudeHookServerFactory,
} from "./ClaudeHookServer.ts";
import {
  advanceClaudePtyReadiness,
  buildClaudePtyLaunchSpec,
  claudePtyOutputRequestsWorkspaceTrust,
  durableClaudeTranscriptOffset,
  encodeClaudeTypedInput,
  initialClaudePtyReadiness,
  parseClaudeTranscriptRecord,
  type ClaudePtyReadiness,
  type ClaudeTranscriptSemanticEvent,
  type ClaudeTranscriptCursor,
} from "./ClaudePtyProtocol.ts";
import {
  nodeClaudeTranscriptFileReader,
  startClaudeTranscriptTailer,
  type ClaudeTranscriptTailer,
} from "./ClaudeTranscriptTailer.ts";
import {
  isAllowedClaudeTranscriptPath,
  resolveClaudeTranscriptPath,
} from "./ClaudeTranscriptResolver.ts";
import {
  normalizeClaudeAskUserQuestionAnswers,
  parseClaudeAskUserQuestionInput,
} from "./ClaudeUserInput.ts";

const PROVIDER = ProviderDriverKind.make("claudeAgent");
const DEFAULT_INSTANCE_ID = ProviderInstanceId.make("claudeAgent");
const HOOK_TOKEN_ENV = "ETHEREAL_CLAUDE_HOOK_TOKEN";
const CTRL_C = "\u0003";
const CTRL_D = "\u0004";

interface PendingApproval {
  readonly requestId: ApprovalRequestId;
  readonly requestType: CanonicalRequestType;
  readonly complete: (decision: ProviderApprovalDecision) => Promise<void>;
}

type PendingUserInputResolution =
  | { readonly _tag: "answered"; readonly answers: Record<string, string> }
  | { readonly _tag: "cancelled"; readonly reason: string };

interface PendingUserInput {
  readonly requestId: ApprovalRequestId;
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly complete: (resolution: PendingUserInputResolution) => Promise<void>;
}

interface ClaudePtyTurn {
  readonly turnId: TurnId;
  readonly prompt: string;
  readonly startedAt: string;
  readonly items: unknown[];
  readonly toolItems: Map<
    string,
    {
      readonly itemId: RuntimeItemId;
      readonly itemType: CanonicalItemType;
      readonly toolName: string;
      readonly input: Record<string, unknown>;
    }
  >;
  readonly assistantItems: Set<string>;
  lastAssistantMessageText: string | undefined;
  nativePromptId: string | undefined;
  promptAcknowledged: boolean;
  stopSeen: boolean;
  interruptRequested: boolean;
  semanticActivitySeen: boolean;
  completionStarted: boolean;
  noOutputTimer: ReturnType<typeof setTimeout> | undefined;
  hardTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
}

interface QueuedTurn {
  readonly turnId: TurnId;
  readonly input: ProviderSendTurnInput;
}

interface ClaudePtySessionContext {
  session: ProviderSession;
  readonly sessionId: string;
  process: PtyAdapter.PtyProcess | null;
  readiness: ClaudePtyReadiness;
  readonly ready: Promise<void>;
  readonly resolveReady: () => void;
  readonly rejectReady: (cause: unknown) => void;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly seenTranscriptEvents: Set<string>;
  readonly turns: ClaudePtyTurn[];
  completedTurnCount: number;
  currentTurn: ClaudePtyTurn | undefined;
  queuedTurn: QueuedTurn | undefined;
  transcriptPath: string | undefined;
  transcriptCursor: ClaudeTranscriptCursor | undefined;
  transcriptTailer: ClaudeTranscriptTailer | undefined;
  interactionMode: ProviderInteractionMode;
  hookServer: ClaudeHookServer | undefined;
  exit: Promise<PtyAdapter.PtyExitEvent>;
  resolveExit: (event: PtyAdapter.PtyExitEvent) => void;
  stopping: boolean;
  stopped: boolean;
  unsubscribeData: (() => void) | undefined;
  unsubscribeExit: (() => void) | undefined;
  readinessSettleTimer: ReturnType<typeof setTimeout> | undefined;
  workspaceTrustAccepted: boolean;
}

export interface ClaudePtyAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly idFactory?: () => string;
  readonly now?: () => string;
  readonly hookServerFactory?: ClaudeHookServerFactory;
  readonly transcriptTailerFactory?: typeof startClaudeTranscriptTailer;
  readonly readinessTimeoutMs?: number;
  readonly readinessSettleMs?: number;
  readonly approvalTimeoutMs?: number;
  readonly userInputTimeoutMs?: number;
  readonly noOutputWarningMs?: number;
  readonly hardTurnTimeoutMs?: number;
  readonly shutdownGraceMs?: number;
  readonly subscriptionOnly?: boolean;
  readonly resolveAttachmentPath?: (
    attachment: NonNullable<ProviderSendTurnInput["attachments"]>[number],
  ) => string | null;
}

function randomId(): string {
  // @effect-diagnostics-next-line cryptoRandomUUID:off - Adapter option injection keeps tests deterministic; the live fallback needs cryptographic ids.
  return globalThis.crypto.randomUUID();
}

function bestEffortProcessWrite(process: PtyAdapter.PtyProcess | null, value: string): void {
  try {
    process?.write(value);
  } catch {
    // Shutdown escalation remains authoritative.
  }
}

function bestEffortProcessKill(process: PtyAdapter.PtyProcess | null, signal: string): void {
  try {
    process?.kill(signal);
  } catch {
    // The process may already be gone without delivering onExit.
  }
}

interface ClaudePtyResumeCursor {
  readonly schemaVersion: 1;
  readonly nativeSessionId: string;
  readonly providerInstanceId: string;
  readonly homeIdentity: string;
  readonly transcriptPath?: string;
  readonly transcriptOffset?: number;
  readonly turnCount: number;
}

function readResumeSessionId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.nativeSessionId === "string" && record.nativeSessionId.length > 0) {
    return record.nativeSessionId;
  }
  if (typeof record.sessionId === "string" && record.sessionId.length > 0) return record.sessionId;
  if (typeof record.resume === "string" && record.resume.length > 0) return record.resume;
  return undefined;
}

function readResumeTranscriptPath(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const path = (value as Record<string, unknown>).transcriptPath;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

function readResumeTranscriptOffset(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const offset = (value as Record<string, unknown>).transcriptOffset;
  return typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0
    ? offset
    : undefined;
}

function readResumeTurnCount(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const count = (value as Record<string, unknown>).turnCount;
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function classifyRequestType(toolName: string | undefined): CanonicalRequestType {
  if (toolName === "Bash") return "command_execution_approval";
  if (toolName && ["Read", "Glob", "Grep"].includes(toolName)) return "file_read_approval";
  if (toolName && ["Edit", "MultiEdit", "NotebookEdit", "Write"].includes(toolName)) {
    return "file_change_approval";
  }
  return "dynamic_tool_call";
}

function approvalResponse(
  hook: ClaudeHookInput,
  decision: ProviderApprovalDecision,
): ClaudeHookResponse {
  if (decision === "accept" || decision === "acceptForSession") {
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          ...(hook.tool_input ? { updatedInput: hook.tool_input } : {}),
          ...(decision === "acceptForSession" && hook.permission_suggestions
            ? { updatedPermissions: hook.permission_suggestions }
            : {}),
        },
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "deny",
        message:
          decision === "cancel"
            ? "User cancelled tool execution."
            : "User declined tool execution.",
        interrupt: false,
      },
    },
  };
}

function userInputResponse(
  hook: ClaudeHookInput,
  resolution: PendingUserInputResolution,
): ClaudeHookResponse {
  if (resolution._tag === "answered") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "User answered Claude's question in Ethereal.",
        updatedInput: {
          ...hook.tool_input,
          answers: resolution.answers,
        },
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: resolution.reason,
    },
  };
}

export const makeClaudePtyAdapter = Effect.fn("makeClaudePtyAdapter")(function* (
  claudeSettings: ClaudeSettings,
  options: ClaudePtyAdapterOptions = {},
): Effect.fn.Return<
  ProviderAdapterShape<ProviderAdapterError>,
  ProviderAdapterProcessError,
  Path.Path | PtyAdapter.PtyAdapter | Scope.Scope
> {
  const ptyAdapter = yield* PtyAdapter.PtyAdapter;
  const pathService = yield* Path.Path;
  const eventBus = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const sessionsByThread = new Map<ThreadId, ClaudePtySessionContext>();
  const sessionsByClaudeId = new Map<string, ClaudePtySessionContext>();
  const boundInstanceId = options.instanceId ?? DEFAULT_INSTANCE_ID;
  const idFactory = options.idFactory ?? randomId;
  // @effect-diagnostics-next-line globalDate:off - Adapter option injection supplies deterministic clocks in tests; wire timestamps are ISO strings.
  const now = options.now ?? (() => new Date().toISOString());
  const transcriptTailerFactory = options.transcriptTailerFactory ?? startClaudeTranscriptTailer;
  const readinessTimeoutMs = options.readinessTimeoutMs ?? 15_000;
  const readinessSettleMs = options.readinessSettleMs ?? 1_000;
  const approvalTimeoutMs = options.approvalTimeoutMs ?? 120_000;
  const userInputTimeoutMs = options.userInputTimeoutMs ?? 10 * 60_000;
  const noOutputWarningMs = options.noOutputWarningMs ?? 30_000;
  const hardTurnTimeoutMs = options.hardTurnTimeoutMs ?? 20 * 60_000;
  const shutdownGraceMs = options.shutdownGraceMs ?? 1_500;
  const runtimeContext = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(runtimeContext);
  const effectiveHome = yield* resolveClaudeHomePath(claudeSettings);
  const baseEnvironment = yield* makeClaudeEnvironment(
    claudeSettings,
    options.environment ?? process.env,
  );

  const stamp = () => ({ eventId: EventId.make(idFactory()), createdAt: now() });
  const emit = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    PubSub.publish(eventBus, event).pipe(Effect.asVoid);

  const updateResumeCursor = (context: ClaudePtySessionContext): void => {
    const currentCursor = context.transcriptTailer?.getCursor() ?? context.transcriptCursor;
    const resumeCursor: ClaudePtyResumeCursor = {
      schemaVersion: 1,
      nativeSessionId: context.sessionId,
      providerInstanceId: boundInstanceId,
      homeIdentity: effectiveHome,
      ...(context.transcriptPath ? { transcriptPath: context.transcriptPath } : {}),
      ...(currentCursor ? { transcriptOffset: durableClaudeTranscriptOffset(currentCursor) } : {}),
      turnCount: context.completedTurnCount,
    };
    context.session = {
      ...context.session,
      resumeCursor,
      updatedAt: now(),
    };
  };

  const startTranscript = (context: ClaudePtySessionContext, path: string): void => {
    if (context.transcriptPath === path && context.transcriptTailer) return;
    context.transcriptTailer?.close();
    if (context.transcriptPath !== undefined && context.transcriptPath !== path) {
      context.transcriptCursor = undefined;
    }
    context.transcriptPath = path;
    updateResumeCursor(context);
    context.transcriptTailer = transcriptTailerFactory({
      path,
      ...(context.transcriptCursor ? { initialCursor: context.transcriptCursor } : {}),
      onRecord: (record) => runPromise(handleTranscriptRecord(context, record)),
      onCursor: (cursor) => {
        context.transcriptCursor = cursor;
        updateResumeCursor(context);
      },
      onWarning: (message) =>
        runPromise(
          emit({
            type: "runtime.warning",
            ...stamp(),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.session.threadId,
            ...(context.currentTurn ? { turnId: context.currentTurn.turnId } : {}),
            payload: { message },
            providerRefs: {},
            raw: { source: "claude.transcript.jsonl", payload: { path } },
          }),
        ),
    });
  };

  const clearTurnTimers = (turn: ClaudePtyTurn): void => {
    if (turn.noOutputTimer) clearTimeout(turn.noOutputTimer);
    if (turn.hardTimeoutTimer) clearTimeout(turn.hardTimeoutTimer);
    turn.noOutputTimer = undefined;
    turn.hardTimeoutTimer = undefined;
  };

  const semanticEventKey = (
    semantic: ClaudeTranscriptSemanticEvent,
    rawRecord: Record<string, unknown>,
  ): string => {
    const recordId = typeof rawRecord.uuid === "string" ? rawRecord.uuid : "record";
    switch (semantic.type) {
      case "assistant-text":
        return `${recordId}:assistant:${semantic.messageId}:${semantic.blockIndex}`;
      case "assistant-stop":
        return `${recordId}:stop:${semantic.messageId}:${semantic.reason}`;
      case "tool-started":
        return `${recordId}:tool:${semantic.toolUseId}`;
      case "tool-completed":
        return `${recordId}:result:${semantic.toolUseId}`;
      case "user-acknowledged":
        return `${recordId}:user:${semantic.messageId}`;
      case "usage":
        return `${recordId}:usage`;
    }
  };

  const transcriptDiagnosticPayload = (
    record: Record<string, unknown>,
  ): Record<string, unknown> => {
    const message =
      record.message && typeof record.message === "object" && !Array.isArray(record.message)
        ? (record.message as Record<string, unknown>)
        : undefined;
    return {
      ...(typeof record.type === "string" ? { type: record.type } : {}),
      ...(typeof record.uuid === "string" ? { uuid: record.uuid } : {}),
      ...(message && Array.isArray(message.content)
        ? { contentBlockCount: message.content.length }
        : {}),
      ...(message && typeof message.stop_reason === "string"
        ? { stopReason: message.stop_reason }
        : {}),
    };
  };

  const handleSemanticEvent = Effect.fn("claudeAgent.handleSemanticEvent")(function* (
    context: ClaudePtySessionContext,
    semantic: ClaudeTranscriptSemanticEvent,
    rawRecord: Record<string, unknown>,
  ) {
    const turn = context.currentTurn;
    if (!turn) return;
    const eventKey = semanticEventKey(semantic, rawRecord);
    if (context.seenTranscriptEvents.has(eventKey)) return;
    context.seenTranscriptEvents.add(eventKey);
    if (context.seenTranscriptEvents.size > 20_000) {
      const oldest = context.seenTranscriptEvents.values().next().value;
      if (oldest !== undefined) context.seenTranscriptEvents.delete(oldest);
    }
    turn.semanticActivitySeen = true;
    const raw = {
      source: "claude.transcript.jsonl" as const,
      payload: transcriptDiagnosticPayload(rawRecord),
    };
    if (semantic.type === "user-acknowledged") {
      if (semantic.text === turn.prompt) turn.promptAcknowledged = true;
      return;
    }
    if (semantic.type === "assistant-stop") {
      if (semantic.reason !== "tool_use") turn.stopSeen = true;
      return;
    }
    if (semantic.type === "assistant-text") {
      const key = `${semantic.messageId}:${semantic.blockIndex}`;
      const itemId = RuntimeItemId.make(`assistant-${semantic.messageId}-${semantic.blockIndex}`);
      if (!turn.assistantItems.has(key)) {
        turn.assistantItems.add(key);
        yield* emit({
          type: "item.started",
          ...stamp(),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          turnId: turn.turnId,
          itemId,
          payload: { itemType: "assistant_message", status: "inProgress" },
          providerRefs: {},
          raw,
        });
      }
      for (let offset = 0; offset < semantic.text.length; offset += 8_192) {
        yield* emit({
          type: "content.delta",
          ...stamp(),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          turnId: turn.turnId,
          itemId,
          payload: {
            streamKind: "assistant_text",
            delta: semantic.text.slice(offset, offset + 8_192),
            contentIndex: semantic.blockIndex,
          },
          providerRefs: {},
          raw,
        });
      }
      yield* emit({
        type: "item.completed",
        ...stamp(),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        turnId: turn.turnId,
        itemId,
        payload: {
          itemType: "assistant_message",
          status: "completed",
          data: {
            text: semantic.text.slice(0, 16_384),
            ...(semantic.text.length > 16_384 ? { truncated: true } : {}),
          },
        },
        providerRefs: {},
        raw,
      });
      turn.items.push(semantic);
      return;
    }
    if (semantic.type === "tool-started") {
      // Hook-triggered polls and the interval poll can overlap. A tool-use id
      // is native-session unique, so never render a second card for it.
      if (turn.toolItems.has(semantic.toolUseId)) return;
      const itemId = RuntimeItemId.make(`tool-${semantic.toolUseId}`);
      turn.toolItems.set(semantic.toolUseId, {
        itemId,
        itemType: semantic.itemType,
        toolName: semantic.toolName,
        input: semantic.input,
      });
      yield* emit({
        type: "item.started",
        ...stamp(),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        turnId: turn.turnId,
        itemId,
        payload: {
          itemType: semantic.itemType,
          status: "inProgress",
          title: semantic.toolName,
          data: { input: semantic.input },
        },
        providerRefs: { providerItemId: ProviderItemId.make(semantic.toolUseId) },
        raw,
      });
      turn.items.push(semantic);
      return;
    }
    if (semantic.type === "tool-completed") {
      const startedTool = turn.toolItems.get(semantic.toolUseId);
      const itemId = startedTool?.itemId ?? RuntimeItemId.make(`tool-${semantic.toolUseId}`);
      yield* emit({
        type: "item.completed",
        ...stamp(),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        turnId: turn.turnId,
        itemId,
        payload: {
          itemType: startedTool?.itemType ?? "dynamic_tool_call",
          status: semantic.failed ? "failed" : "completed",
          ...(startedTool ? { title: startedTool.toolName } : {}),
          data: {
            toolCallId: semantic.toolUseId,
            ...(startedTool ? { input: startedTool.input } : {}),
            ...(startedTool && typeof startedTool.input.command === "string"
              ? { command: startedTool.input.command }
              : {}),
            rawOutput: { content: semantic.content },
          },
        },
        providerRefs: { providerItemId: ProviderItemId.make(semantic.toolUseId) },
        raw,
      });
      turn.toolItems.delete(semantic.toolUseId);
      turn.items.push(semantic);
      return;
    }
    yield* emit({
      type: "thread.token-usage.updated",
      ...stamp(),
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId: context.session.threadId,
      turnId: turn.turnId,
      payload: {
        usage: {
          usedTokens: semantic.inputTokens + semantic.outputTokens,
          inputTokens: semantic.inputTokens,
          outputTokens: semantic.outputTokens,
          lastInputTokens: semantic.inputTokens,
          lastOutputTokens: semantic.outputTokens,
        },
      },
      providerRefs: {},
      raw,
    });
  });

  const handleTranscriptRecord = Effect.fn("claudeAgent.handleTranscriptRecord")(function* (
    context: ClaudePtySessionContext,
    record: Record<string, unknown>,
  ) {
    if (context.stopped) return;
    const turn = context.currentTurn;
    if (
      turn &&
      typeof record.timestamp === "string" &&
      Date.parse(record.timestamp) < Date.parse(turn.startedAt)
    ) {
      return;
    }
    const semantics = parseClaudeTranscriptRecord(record);
    const assistantMessageText = semantics
      .filter(
        (
          semantic,
        ): semantic is Extract<ClaudeTranscriptSemanticEvent, { type: "assistant-text" }> =>
          semantic.type === "assistant-text",
      )
      .map((semantic) => semantic.text)
      .join("\n");
    if (turn && assistantMessageText.length > 0) {
      turn.lastAssistantMessageText = assistantMessageText;
    }
    for (const semantic of semantics) {
      yield* handleSemanticEvent(context, semantic, record);
    }
    yield* maybeCompleteTurn(context);
  });

  const completeTurn = Effect.fn("claudeAgent.completeTurn")(function* (
    context: ClaudePtySessionContext,
    state: "completed" | "interrupted" | "failed" = "completed",
  ) {
    const turn = context.currentTurn;
    if (!turn || turn.completionStarted) return;
    turn.completionStarted = true;
    context.currentTurn = undefined;
    clearTurnTimers(turn);
    yield* emit({
      type: "turn.completed",
      ...stamp(),
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId: context.session.threadId,
      turnId: turn.turnId,
      payload: {
        state,
        usage: {
          runtimeDurationMs: Math.max(0, Date.parse(now()) - Date.parse(turn.startedAt)),
          toolCount: turn.items.filter(
            (item) =>
              item &&
              typeof item === "object" &&
              "type" in item &&
              (item as { readonly type?: unknown }).type === "tool-started",
          ).length,
          retryCount: 0,
          interruptionCount: turn.interruptRequested ? 1 : 0,
          transcriptBytesProcessed:
            context.transcriptTailer?.getCursor().offset ?? context.transcriptCursor?.offset ?? 0,
        },
      },
      providerRefs: { providerTurnId: turn.turnId },
      raw: { source: "claude.pty.hook", method: "Stop", payload: {} },
    });
    context.turns.push(turn);
    context.completedTurnCount += 1;
    updateResumeCursor(context);
    if (context.stopped) {
      context.queuedTurn = undefined;
      return;
    }
    context.readiness = advanceClaudePtyReadiness(context.readiness, { type: "turn-completed" });
    context.session = {
      ...context.session,
      status: "ready",
      activeTurnId: undefined,
      updatedAt: now(),
    };
    yield* emit({
      type: "session.state.changed",
      ...stamp(),
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId: context.session.threadId,
      payload: { state: "ready" },
      providerRefs: {},
    });
    const queued = context.queuedTurn;
    context.queuedTurn = undefined;
    if (queued) yield* beginTurn(context, queued.input, queued.turnId);
  });

  const maybeCompleteTurn = Effect.fn("claudeAgent.maybeCompleteTurn")(function* (
    context: ClaudePtySessionContext,
  ) {
    const turn = context.currentTurn;
    if (!turn || !turn.stopSeen || !turn.promptAcknowledged || turn.toolItems.size > 0) {
      return;
    }
    yield* completeTurn(context, turn.interruptRequested ? "interrupted" : "completed");
  });

  const armTurnTimers = (context: ClaudePtySessionContext, turn: ClaudePtyTurn): void => {
    // @effect-diagnostics globalTimers:off - Native PTY timeouts outlive the initiating request and are cleared with the turn.
    turn.noOutputTimer = setTimeout(() => {
      if (context.currentTurn !== turn || turn.semanticActivitySeen) return;
      void runPromise(
        emit({
          type: "runtime.warning",
          ...stamp(),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          turnId: turn.turnId,
          payload: {
            message:
              "Claude has not acknowledged the submitted prompt. Complete Claude login, trust, update, or onboarding in a system terminal, then restart this session.",
          },
          providerRefs: {},
        }),
      );
    }, noOutputWarningMs);
    turn.noOutputTimer.unref?.();
    turn.hardTimeoutTimer = setTimeout(() => {
      if (context.currentTurn !== turn) return;
      try {
        context.process?.write(CTRL_C);
      } catch {
        // Process-exit handling below remains authoritative.
      }
      void runPromise(
        emit({
          type: "runtime.error",
          ...stamp(),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          turnId: turn.turnId,
          payload: {
            message: "Claude turn exceeded the configured hard timeout.",
            class: "transport_error",
            detail: { recoverable: true },
          },
          providerRefs: {},
        }).pipe(Effect.andThen(completeTurn(context, "failed"))),
      );
    }, hardTurnTimeoutMs);
    turn.hardTimeoutTimer.unref?.();
  };

  const beginTurn = Effect.fn("claudeAgent.beginTurn")(function* (
    context: ClaudePtySessionContext,
    input: ProviderSendTurnInput,
    turnId: TurnId,
  ) {
    const process = context.process;
    if (!process) {
      return yield* new ProviderAdapterSessionClosedError({
        provider: PROVIDER,
        threadId: context.session.threadId,
      });
    }
    const attachmentReferences: string[] = [];
    for (const attachment of input.attachments ?? []) {
      const attachmentPath = options.resolveAttachmentPath?.(attachment) ?? null;
      if (!attachmentPath) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Claude PTY could not resolve attachment '${attachment.id}'.`,
        });
      }
      attachmentReferences.push(
        `[Attached ${attachment.type}: ${attachment.name} (${attachment.mimeType}) at ${attachmentPath}]`,
      );
    }
    const text = input.input ?? "";
    const prompt = [...attachmentReferences, ...(text.trim().length > 0 ? [text] : [])].join("\n");
    if (prompt.trim().length === 0) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Claude PTY turns require text or a supported file reference.",
      });
    }
    const nextInteractionMode = input.interactionMode ?? context.interactionMode;
    if (context.interactionMode !== nextInteractionMode) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue:
          "Claude PTY interaction mode is fixed for the native session. Restart the session to switch between default and plan mode.",
      });
    }
    const turn: ClaudePtyTurn = {
      turnId,
      prompt,
      startedAt: now(),
      items: [],
      toolItems: new Map(),
      assistantItems: new Set(),
      lastAssistantMessageText: undefined,
      nativePromptId: undefined,
      promptAcknowledged: false,
      stopSeen: false,
      interruptRequested: false,
      semanticActivitySeen: false,
      completionStarted: false,
      noOutputTimer: undefined,
      hardTimeoutTimer: undefined,
    };
    context.currentTurn = turn;
    context.readiness = advanceClaudePtyReadiness(context.readiness, { type: "prompt-submitted" });
    context.session = {
      ...context.session,
      status: "running",
      activeTurnId: turnId,
      updatedAt: now(),
    };
    yield* emit({
      type: "turn.started",
      ...stamp(),
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId: context.session.threadId,
      turnId,
      payload: context.session.model ? { model: context.session.model } : {},
      providerRefs: { providerTurnId: turnId },
    });
    yield* Effect.try({
      // Do not synthesize bracketed-paste control sequences here. Claude Code
      // treats those as a real OS paste and may import unrelated clipboard
      // contents (including file attachments) instead of only these bytes.
      // LF is Claude's native chat:newline key; CR below submits the prompt.
      try: () => process.write(encodeClaudeTypedInput(prompt)),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: "Failed to write the prompt to the Claude PTY.",
          cause,
        }),
    });
    // Claude's supported screen-reader renderer consumes paste and submit as
    // separate terminal input frames. Sending Return in the same write leaves
    // the prompt sitting in the raw terminal without starting the turn.
    yield* Effect.try({
      try: () => process.write("\r"),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: "Failed to submit the prompt to the Claude PTY.",
          cause,
        }),
    });
    armTurnTimers(context, turn);
  });

  const resolveAllApprovals = async (
    context: ClaudePtySessionContext,
    decision: ProviderApprovalDecision,
  ) => {
    await Promise.all(
      [...context.pendingApprovals.values()].map((pending) => pending.complete(decision)),
    );
  };

  const resolveAllUserInputs = async (context: ClaudePtySessionContext, reason: string) => {
    await Promise.all(
      [...context.pendingUserInputs.values()].map((pending) =>
        pending.complete({ _tag: "cancelled", reason }),
      ),
    );
  };

  const handlePermissionRequest = Effect.fn("claudeAgent.handlePermissionRequest")(function* (
    context: ClaudePtySessionContext,
    hook: ClaudeHookInput,
  ) {
    if (context.session.runtimeMode === "full-access") return approvalResponse(hook, "accept");
    const requestId = ApprovalRequestId.make(idFactory());
    const requestType = classifyRequestType(hook.tool_name);
    const response = new Promise<ClaudeHookResponse>((resolve) => {
      let completed = false;
      // @effect-diagnostics-next-line globalTimers:off - The native HTTP approval must fail closed even if no Effect caller remains waiting.
      const timer = setTimeout(() => {
        void complete("cancel");
      }, approvalTimeoutMs);
      timer.unref?.();
      const complete = async (decision: ProviderApprovalDecision) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        context.pendingApprovals.delete(requestId);
        await runPromise(
          emit({
            type: "request.resolved",
            ...stamp(),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.session.threadId,
            ...(context.currentTurn ? { turnId: context.currentTurn.turnId } : {}),
            requestId: RuntimeRequestId.make(requestId),
            payload: { requestType, decision },
            providerRefs: {
              ...(typeof hook.tool_use_id === "string"
                ? { providerItemId: ProviderItemId.make(hook.tool_use_id) }
                : {}),
              providerRequestId: requestId,
            },
            raw: {
              source: "claude.pty.hook",
              method: "PermissionRequest/resolved",
              payload: { decision },
            },
          }),
        );
        if (context.currentTurn) {
          context.readiness = advanceClaudePtyReadiness(context.readiness, {
            type: "permission-resolved",
          });
          await runPromise(
            emit({
              type: "session.state.changed",
              ...stamp(),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: context.session.threadId,
              payload: { state: "running" },
              providerRefs: {},
            }),
          );
        }
        resolve(approvalResponse(hook, decision));
      };
      const pending: PendingApproval = { requestId, requestType, complete };
      context.pendingApprovals.set(requestId, pending);
    });
    yield* emit({
      type: "request.opened",
      ...stamp(),
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId: context.session.threadId,
      ...(context.currentTurn ? { turnId: context.currentTurn.turnId } : {}),
      requestId: RuntimeRequestId.make(requestId),
      payload: {
        requestType,
        ...(hook.tool_name
          ? { detail: `Claude requests permission to use ${hook.tool_name}.` }
          : {}),
        args: {
          ...(hook.tool_name ? { toolName: hook.tool_name } : {}),
          ...(hook.tool_input ? { input: hook.tool_input } : {}),
        },
      },
      providerRefs: { providerRequestId: requestId },
      raw: { source: "claude.pty.hook", method: "PermissionRequest", payload: hook },
    });
    context.readiness = advanceClaudePtyReadiness(context.readiness, {
      type: "permission-requested",
    });
    yield* emit({
      type: "session.state.changed",
      ...stamp(),
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId: context.session.threadId,
      payload: { state: "waiting" },
      providerRefs: {},
    });
    return yield* Effect.promise(() => response);
  });

  const handleAskUserQuestion = Effect.fn("claudeAgent.handleAskUserQuestion")(function* (
    context: ClaudePtySessionContext,
    hook: ClaudeHookInput,
  ) {
    const parsed = parseClaudeAskUserQuestionInput(hook.tool_input);
    if (!parsed) {
      const reason = "Claude sent an invalid AskUserQuestion payload.";
      yield* emit({
        type: "runtime.warning",
        ...stamp(),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        ...(context.currentTurn ? { turnId: context.currentTurn.turnId } : {}),
        payload: { message: reason },
        providerRefs: {},
        raw: { source: "claude.pty.hook", method: "PreToolUse/AskUserQuestion", payload: hook },
      });
      return userInputResponse(hook, { _tag: "cancelled", reason });
    }

    const requestId = ApprovalRequestId.make(idFactory());
    const runtimeRequestId = RuntimeRequestId.make(requestId);
    const response = new Promise<ClaudeHookResponse>((resolve) => {
      let completed = false;
      // @effect-diagnostics-next-line globalTimers:off - The native HTTP hook must fail closed if its UI response never arrives.
      const timer = setTimeout(() => {
        void complete({
          _tag: "cancelled",
          reason: "Claude's question timed out while waiting for user input.",
        });
      }, userInputTimeoutMs);
      timer.unref?.();
      const complete = async (resolution: PendingUserInputResolution) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        context.pendingUserInputs.delete(requestId);
        const answers = resolution._tag === "answered" ? resolution.answers : {};
        await runPromise(
          emit({
            type: "user-input.resolved",
            ...stamp(),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.session.threadId,
            ...(context.currentTurn ? { turnId: context.currentTurn.turnId } : {}),
            requestId: runtimeRequestId,
            payload: { answers },
            providerRefs: {
              ...(hook.tool_use_id
                ? { providerItemId: ProviderItemId.make(hook.tool_use_id) }
                : {}),
              providerRequestId: requestId,
            },
            raw: {
              source: "claude.pty.hook",
              method: "PreToolUse/AskUserQuestion/resolved",
              payload: { resolution: resolution._tag },
            },
          }),
        );
        if (context.currentTurn) {
          await runPromise(
            emit({
              type: "session.state.changed",
              ...stamp(),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: context.session.threadId,
              payload: { state: "running" },
              providerRefs: {},
            }),
          );
        }
        resolve(userInputResponse(hook, resolution));
      };
      context.pendingUserInputs.set(requestId, {
        requestId,
        questions: parsed.questions,
        complete,
      });
    });

    yield* emit({
      type: "user-input.requested",
      ...stamp(),
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId: context.session.threadId,
      ...(context.currentTurn ? { turnId: context.currentTurn.turnId } : {}),
      requestId: runtimeRequestId,
      payload: { questions: parsed.questions },
      providerRefs: {
        ...(hook.tool_use_id ? { providerItemId: ProviderItemId.make(hook.tool_use_id) } : {}),
        providerRequestId: requestId,
      },
      raw: { source: "claude.pty.hook", method: "PreToolUse/AskUserQuestion", payload: hook },
    });
    yield* emit({
      type: "session.state.changed",
      ...stamp(),
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId: context.session.threadId,
      payload: { state: "waiting" },
      providerRefs: {},
    });
    return yield* Effect.promise(() => response);
  });

  const handleHook = Effect.fn("claudeAgent.handleHook")(function* (hook: ClaudeHookInput) {
    const context =
      typeof hook.session_id === "string" ? sessionsByClaudeId.get(hook.session_id) : undefined;
    if (!context || context.stopped) return {};
    if (typeof hook.transcript_path === "string" && hook.transcript_path.length > 0) {
      if (
        isAllowedClaudeTranscriptPath({
          homePath: effectiveHome,
          sessionId: context.sessionId,
          candidatePath: hook.transcript_path,
        })
      ) {
        startTranscript(context, pathService.resolve(hook.transcript_path));
      } else {
        yield* emit({
          type: "runtime.warning",
          ...stamp(),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          ...(context.currentTurn ? { turnId: context.currentTurn.turnId } : {}),
          payload: {
            message: "Claude reported a transcript outside this provider instance's HOME.",
          },
          providerRefs: {},
          raw: {
            source: "claude.pty.hook",
            method: "transcript-path-rejected",
            payload: { sessionId: context.sessionId },
          },
        });
      }
    }
    switch (hook.hook_event_name) {
      case "SessionStart": {
        if (context.transcriptTailer) {
          yield* Effect.promise(() => context.transcriptTailer!.pollNow());
        }
        context.readiness = advanceClaudePtyReadiness(context.readiness, {
          type: "hook",
          event: "SessionStart",
        });
        if (context.session.status !== "ready") {
          if (context.readinessSettleTimer) clearTimeout(context.readinessSettleTimer);
          context.readinessSettleTimer = undefined;
          context.session = { ...context.session, status: "ready", updatedAt: now() };
          context.resolveReady();
          yield* emit({
            type: "session.state.changed",
            ...stamp(),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.session.threadId,
            payload: { state: "ready" },
            providerRefs: {},
            raw: { source: "claude.pty.hook", method: "SessionStart", payload: hook },
          });
        }
        return {};
      }
      case "PermissionRequest":
        return yield* handlePermissionRequest(context, hook);
      case "UserPromptSubmit": {
        if (context.transcriptTailer) {
          // Drain resume-time transcript residue before allowing the new prompt
          // to enter Claude's conversation. The hook is blocking, so the
          // current user record cannot race this poll.
          yield* Effect.promise(() => context.transcriptTailer!.pollNow());
        }
        const turn = context.currentTurn;
        if (!turn || hook.prompt !== turn.prompt) return {};
        turn.nativePromptId = hook.prompt_id;
        turn.promptAcknowledged = true;
        return {};
      }
      case "PreToolUse":
        return hook.tool_name === "AskUserQuestion"
          ? yield* handleAskUserQuestion(context, hook)
          : {};
      case "Stop": {
        const turn = context.currentTurn;
        // A Stop without the matching UserPromptSubmit acknowledgement may be
        // residue from the previous native turn, especially immediately after
        // resume. Never let it complete the current Ethereal turn.
        if (!turn?.nativePromptId || hook.prompt_id !== turn.nativePromptId) {
          return {};
        }
        context.readiness = advanceClaudePtyReadiness(context.readiness, {
          type: "hook",
          event: "Stop",
        });
        if (context.transcriptTailer) {
          yield* Effect.promise(() => context.transcriptTailer!.pollNow());
        }
        // Transcript records written before Stop must be projected before Stop
        // can make the turn completable. Otherwise an earlier assistant block
        // or tool result can complete the turn and orphan later tool/final
        // records from the same drain.
        if (context.currentTurn !== turn) return {};
        turn.stopSeen = true;
        if (
          typeof hook.last_assistant_message === "string" &&
          hook.last_assistant_message.length > 0 &&
          turn.lastAssistantMessageText !== hook.last_assistant_message
        ) {
          const messageId = `stop-${hook.prompt_id ?? turn.turnId}`;
          yield* handleSemanticEvent(
            context,
            {
              type: "assistant-text",
              messageId,
              blockIndex: 0,
              text: hook.last_assistant_message,
            },
            {
              type: "hook",
              uuid: messageId,
              message: { content: [{ type: "text", text: hook.last_assistant_message }] },
            },
          );
        }
        yield* maybeCompleteTurn(context);
        return {};
      }
      case "SessionEnd":
        context.readiness = advanceClaudePtyReadiness(context.readiness, {
          type: "hook",
          event: "SessionEnd",
        });
        return {};
      default:
        return {};
    }
  });

  const handleProcessExit = Effect.fn("claudeAgent.handleProcessExit")(function* (
    context: ClaudePtySessionContext,
    event: PtyAdapter.PtyExitEvent,
  ) {
    if (context.stopped) return;
    const intentionalStop = context.stopping;
    const gracefulExit = intentionalStop || event.exitCode === 0;
    const exitReason = intentionalStop
      ? "Session stopped"
      : `Claude exited with code ${event.exitCode}.`;
    context.stopped = true;
    if (context.readinessSettleTimer) clearTimeout(context.readinessSettleTimer);
    context.readinessSettleTimer = undefined;
    context.readiness = advanceClaudePtyReadiness(context.readiness, {
      type: "process-exit",
      reason: exitReason,
    });
    context.rejectReady(new Error(exitReason));
    context.transcriptTailer?.close();
    yield* Effect.promise(() => resolveAllApprovals(context, "cancel"));
    yield* Effect.promise(() =>
      resolveAllUserInputs(context, "Claude exited before the question was answered."),
    );
    if (context.currentTurn) {
      yield* completeTurn(
        context,
        context.currentTurn.interruptRequested || gracefulExit ? "interrupted" : "failed",
      );
    }
    context.session = {
      ...context.session,
      status: gracefulExit ? "closed" : "error",
      activeTurnId: undefined,
      updatedAt: now(),
      ...(gracefulExit ? {} : { lastError: exitReason }),
    };
    if (!intentionalStop) {
      yield* emit({
        type: "runtime.error",
        ...stamp(),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        payload: {
          message: `Claude interactive process exited with code ${event.exitCode}.`,
          class: "transport_error",
          detail: { exitCode: event.exitCode, signal: event.signal, recoverable: true },
        },
        providerRefs: {},
      });
    }
    yield* emit({
      type: "session.exited",
      ...stamp(),
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId: context.session.threadId,
      payload: {
        reason: exitReason,
        exitKind: gracefulExit ? "graceful" : "error",
        recoverable: !intentionalStop,
      },
      providerRefs: {},
    });
    if (sessionsByThread.get(context.session.threadId) === context) {
      sessionsByThread.delete(context.session.threadId);
    }
    if (sessionsByClaudeId.get(context.sessionId) === context) {
      sessionsByClaudeId.delete(context.sessionId);
    }
    if (context.hookServer) {
      yield* Effect.tryPromise(() => context.hookServer!.close()).pipe(Effect.ignore);
      context.hookServer = undefined;
    }
    // Resolve only after lifecycle events and cleanup are complete. A session
    // restart waits on this promise; resolving earlier let the replacement PTY
    // start while the old exit handler could still delete or stop it.
    context.resolveExit(event);
  });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<ClaudePtySessionContext, ProviderAdapterError> => {
    const context = sessionsByThread.get(threadId);
    if (!context) {
      return Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    }
    if (context.stopped || context.session.status === "closed") {
      return Effect.fail(new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId }));
    }
    return Effect.succeed(context);
  };

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = Effect.fn(
    "claudeAgent.startSession",
  )(function* (input) {
    if (input.provider !== undefined && input.provider !== PROVIDER) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
      });
    }
    const existing = sessionsByThread.get(input.threadId);
    if (existing) {
      yield* stopSessionInternal(existing, false);
    }
    const resumeSessionId = readResumeSessionId(input.resumeCursor);
    const sessionId = resumeSessionId ?? idFactory();
    if (input.resumeCursor && typeof input.resumeCursor === "object") {
      const record = input.resumeCursor as Record<string, unknown>;
      if (
        typeof record.providerInstanceId === "string" &&
        record.providerInstanceId !== boundInstanceId
      ) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "Claude resume state belongs to another provider instance.",
        });
      }
      if (typeof record.homeIdentity === "string" && record.homeIdentity !== effectiveHome) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "Claude resume state belongs to another Claude HOME.",
        });
      }
    }
    let resolveReady!: () => void;
    let rejectReady!: (cause: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    let resolveExit!: (event: PtyAdapter.PtyExitEvent) => void;
    const exit = new Promise<PtyAdapter.PtyExitEvent>((resolve) => {
      resolveExit = resolve;
    });
    const startedAt = now();
    const modelSelection =
      input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
    const cwd = input.cwd ?? process.cwd();
    const resumeTranscriptPath = readResumeTranscriptPath(input.resumeCursor);
    const allowedResumeTranscriptPath =
      resumeTranscriptPath &&
      isAllowedClaudeTranscriptPath({
        homePath: effectiveHome,
        sessionId,
        candidatePath: resumeTranscriptPath,
      })
        ? pathService.resolve(resumeTranscriptPath)
        : undefined;
    const resumeTranscriptOffset = readResumeTranscriptOffset(input.resumeCursor);
    const context: ClaudePtySessionContext = {
      session: {
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        status: "connecting",
        runtimeMode: input.runtimeMode,
        cwd,
        ...(modelSelection?.model ? { model: modelSelection.model } : {}),
        threadId: input.threadId,
        createdAt: startedAt,
        updatedAt: startedAt,
      },
      sessionId,
      process: null,
      readiness: initialClaudePtyReadiness,
      ready,
      resolveReady,
      rejectReady,
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      seenTranscriptEvents: new Set(),
      turns: [],
      completedTurnCount: readResumeTurnCount(input.resumeCursor),
      currentTurn: undefined,
      queuedTurn: undefined,
      transcriptPath: allowedResumeTranscriptPath,
      transcriptCursor:
        resumeTranscriptOffset !== undefined
          ? { offset: resumeTranscriptOffset, pending: new Uint8Array() }
          : undefined,
      transcriptTailer: undefined,
      interactionMode: input.interactionMode ?? "default",
      hookServer: undefined,
      exit,
      resolveExit,
      stopping: false,
      stopped: false,
      unsubscribeData: undefined,
      unsubscribeExit: undefined,
      readinessSettleTimer: undefined,
      workspaceTrustAccepted: false,
    };
    updateResumeCursor(context);
    sessionsByThread.set(input.threadId, context);
    sessionsByClaudeId.set(sessionId, context);
    const hookToken = idFactory();
    context.hookServer = yield* Effect.tryPromise({
      try: () =>
        (options.hookServerFactory ?? startClaudeHookServer)({
          token: hookToken,
          sessionId,
          onHook: (hook) => runPromise(handleHook(hook)),
        }),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: "Failed to start the private Claude hook server.",
          cause,
        }),
    }).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          if (sessionsByThread.get(input.threadId) === context) {
            sessionsByThread.delete(input.threadId);
          }
          if (sessionsByClaudeId.get(sessionId) === context) {
            sessionsByClaudeId.delete(sessionId);
          }
        }),
      ),
    );
    if (resumeSessionId && !context.transcriptPath) {
      const resolvedTranscript = yield* Effect.tryPromise(() =>
        resolveClaudeTranscriptPath({ homePath: effectiveHome, cwd, sessionId }),
      ).pipe(Effect.orElseSucceed(() => undefined));
      if (resolvedTranscript) context.transcriptPath = resolvedTranscript;
    }
    if (resumeSessionId && context.transcriptPath && context.transcriptCursor === undefined) {
      const existingSize = yield* Effect.tryPromise(() =>
        nodeClaudeTranscriptFileReader.size(context.transcriptPath!),
      ).pipe(Effect.orElseSucceed(() => undefined));
      if (existingSize !== undefined) {
        context.transcriptCursor = { offset: existingSize, pending: new Uint8Array() };
      }
    }
    if (context.transcriptPath) startTranscript(context, context.transcriptPath);
    const launch = buildClaudePtyLaunchSpec({
      binaryPath: claudeSettings.binaryPath,
      cwd,
      homePath: effectiveHome,
      sessionId,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      ...(modelSelection?.model ? { model: modelSelection.model } : {}),
      ...(getModelSelectionStringOptionValue(modelSelection, "effort")
        ? { effort: getModelSelectionStringOptionValue(modelSelection, "effort")! }
        : {}),
      runtimeMode: input.runtimeMode,
      interactionMode: context.interactionMode,
      hookUrl: context.hookServer.url,
      hookTokenEnvironmentVariable: HOOK_TOKEN_ENV,
      hookToken,
      baseEnvironment,
      launchArgs: claudeSettings.launchArgs,
      ...(options.subscriptionOnly !== undefined
        ? { subscriptionOnly: options.subscriptionOnly }
        : {}),
    });
    const spawned = yield* ptyAdapter
      .spawn({
        shell: launch.command,
        args: [...launch.args],
        cwd: launch.cwd,
        cols: 120,
        rows: 36,
        env: launch.environment,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: "Failed to spawn the interactive Claude PTY.",
              cause,
            }),
        ),
        Effect.tapError(() =>
          Effect.gen(function* () {
            context.stopped = true;
            context.transcriptTailer?.close();
            if (context.hookServer) {
              yield* Effect.tryPromise(() => context.hookServer!.close()).pipe(Effect.ignore);
            }
            if (sessionsByThread.get(input.threadId) === context) {
              sessionsByThread.delete(input.threadId);
            }
            if (sessionsByClaudeId.get(sessionId) === context) {
              sessionsByClaudeId.delete(sessionId);
            }
          }),
        ),
      );
    context.process = spawned;
    context.readiness = advanceClaudePtyReadiness(context.readiness, { type: "spawned" });
    context.unsubscribeData = spawned.onData((data) => {
      const bufferedOutput = context.readiness.lastOutput + data;
      if (
        input.workspaceTrust === "app-created" &&
        claudePtyOutputRequestsWorkspaceTrust(bufferedOutput, launch.cwd)
      ) {
        context.readiness = { state: "starting", lastOutput: "" };
        if (!context.workspaceTrustAccepted) {
          context.workspaceTrustAccepted = true;
          bestEffortProcessWrite(context.process, "y\r");
        }
        return;
      }
      context.readiness = advanceClaudePtyReadiness(context.readiness, {
        type: "pty-output",
        data,
      });
      if (context.currentTurn?.interruptRequested && context.readiness.state === "ready") {
        void runPromise(completeTurn(context, "interrupted"));
        return;
      }
      if (context.readiness.state === "ready" && context.session.status !== "ready") {
        if (context.readinessSettleTimer) clearTimeout(context.readinessSettleTimer);
        // @effect-diagnostics-next-line globalTimers:off - The interactive renderer redraws its first idle prompt while plugins and MCP status settle.
        context.readinessSettleTimer = setTimeout(() => {
          context.readinessSettleTimer = undefined;
          if (
            context.stopped ||
            context.readiness.state !== "ready" ||
            context.session.status === "ready"
          ) {
            return;
          }
          context.session = { ...context.session, status: "ready", updatedAt: now() };
          context.resolveReady();
          void runPromise(
            emit({
              type: "session.state.changed",
              ...stamp(),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: context.session.threadId,
              payload: { state: "ready" },
              providerRefs: {},
              raw: { source: "claude.pty", method: "screen-reader-ready", payload: {} },
            }),
          );
        }, readinessSettleMs);
        context.readinessSettleTimer.unref?.();
      }
    });
    context.unsubscribeExit = spawned.onExit((event) => {
      void runPromise(handleProcessExit(context, event));
    });
    yield* emit({
      type: "session.started",
      ...stamp(),
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId: input.threadId,
      payload: input.resumeCursor === undefined ? {} : { resume: input.resumeCursor },
      providerRefs: {},
    });
    yield* emit({
      type: "session.configured",
      ...stamp(),
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId: input.threadId,
      payload: {
        config: {
          transport: "interactive-pty",
          cwd: launch.cwd,
          ...(modelSelection?.model ? { model: modelSelection.model } : {}),
          runtimeMode: input.runtimeMode,
        },
      },
      providerRefs: {},
    });
    yield* emit({
      type: "thread.started",
      ...stamp(),
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId: input.threadId,
      payload: { providerThreadId: sessionId },
      providerRefs: {},
    });
    const readyBeforeTimeout = yield* Effect.promise(() =>
      Promise.race([
        ready.then(() => true),
        new Promise<false>((resolve) => {
          // @effect-diagnostics-next-line globalTimers:off - Startup attention timeout preserves the live PTY for manual recovery.
          const timeout = setTimeout(() => resolve(false), readinessTimeoutMs);
          timeout.unref?.();
        }),
      ]),
    );
    if (!readyBeforeTimeout) {
      context.readiness = advanceClaudePtyReadiness(context.readiness, {
        type: "attention",
        reason: "Claude requires attention before accepting prompts.",
      });
      context.session = {
        ...context.session,
        status: "error",
        lastError:
          "Claude did not report a ready session. Complete Claude login, trust, update, or onboarding in a system terminal, then restart this session.",
        updatedAt: now(),
      };
      yield* emit({
        type: "session.state.changed",
        ...stamp(),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: input.threadId,
        payload: { state: "waiting" },
        providerRefs: {},
      });
      yield* emit({
        type: "runtime.warning",
        ...stamp(),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: input.threadId,
        payload: { message: context.session.lastError! },
        providerRefs: {},
      });
    }
    return { ...context.session };
  });

  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = Effect.fn(
    "claudeAgent.sendTurn",
  )(function* (input) {
    const context = yield* requireSession(input.threadId);
    if (!context.currentTurn && context.readiness.state !== "ready") {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail:
          "Claude is not ready for native composer input. Resolve Claude setup in a system terminal, then restart this session.",
      });
    }
    const turnId = TurnId.make(idFactory());
    if (context.currentTurn) {
      if (context.queuedTurn) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: "Claude already has one queued turn for this session.",
        });
      }
      context.queuedTurn = { turnId, input };
    } else {
      yield* beginTurn(context, input, turnId);
    }
    return { threadId: input.threadId, turnId, resumeCursor: context.session.resumeCursor };
  });

  const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = Effect.fn(
    "claudeAgent.interruptTurn",
  )(function* (threadId) {
    const context = yield* requireSession(threadId);
    if (!context.process) return;
    if (context.currentTurn) context.currentTurn.interruptRequested = true;
    yield* Effect.promise(() =>
      resolveAllUserInputs(context, "User interrupted Claude before answering the question."),
    );
    context.readiness = advanceClaudePtyReadiness(context.readiness, {
      type: "interrupt-requested",
    });
    yield* Effect.try({
      try: () => context.process!.write(CTRL_C),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/interrupt",
          detail: "Failed to interrupt the Claude PTY.",
          cause,
        }),
    });
  });

  const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] =
    Effect.fn("claudeAgent.respondToRequest")(function* (threadId, requestId, decision) {
      const context = yield* requireSession(threadId);
      const pending = context.pendingApprovals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "item/requestApproval/decision",
          detail: `Unknown pending approval request: ${requestId}`,
        });
      }
      yield* Effect.tryPromise({
        try: () => pending.complete(decision),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "item/requestApproval/decision",
            detail: "Failed to resolve the Claude approval hook.",
            cause,
          }),
      });
    });

  const stopSessionInternal = Effect.fn("claudeAgent.stopSessionInternal")(function* (
    context: ClaudePtySessionContext,
    emitExit: boolean,
  ) {
    if (context.stopped) return;
    if (context.stopping) {
      return;
    }
    context.stopping = true;
    yield* Effect.promise(() => resolveAllApprovals(context, "cancel"));
    yield* Effect.promise(() =>
      resolveAllUserInputs(context, "Claude session stopped before the question was answered."),
    );
    const waitForExit = (milliseconds: number) =>
      Promise.race([
        context.exit.then(() => true),
        new Promise<false>((resolve) => {
          // @effect-diagnostics-next-line globalTimers:off - Provider shutdown has a bounded graceful-to-forced escalation.
          const timer = setTimeout(() => resolve(false), milliseconds);
          timer.unref?.();
        }),
      ]);
    if (context.process) {
      // EOF exits the idle interactive client without recording a synthetic
      // `/exit` command in the durable conversation. Those local-command
      // records can produce a late Stop hook after the next resume and race a
      // newly submitted Ethereal turn.
      bestEffortProcessWrite(context.process, CTRL_D);
      if (yield* Effect.promise(() => waitForExit(shutdownGraceMs))) return;
      bestEffortProcessKill(context.process, "SIGTERM");
      if (yield* Effect.promise(() => waitForExit(Math.min(shutdownGraceMs, 500)))) return;
      bestEffortProcessKill(context.process, "SIGKILL");
    }
    context.stopped = true;
    if (context.readinessSettleTimer) clearTimeout(context.readinessSettleTimer);
    context.readinessSettleTimer = undefined;
    context.transcriptTailer?.close();
    if (context.currentTurn) yield* completeTurn(context, "interrupted");
    context.unsubscribeData?.();
    context.unsubscribeExit?.();
    context.session = {
      ...context.session,
      status: "closed",
      activeTurnId: undefined,
      updatedAt: now(),
    };
    if (sessionsByThread.get(context.session.threadId) === context) {
      sessionsByThread.delete(context.session.threadId);
    }
    if (sessionsByClaudeId.get(context.sessionId) === context) {
      sessionsByClaudeId.delete(context.sessionId);
    }
    if (context.hookServer) {
      yield* Effect.tryPromise(() => context.hookServer!.close()).pipe(Effect.ignore);
      context.hookServer = undefined;
    }
    if (emitExit) {
      yield* emit({
        type: "session.exited",
        ...stamp(),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        payload: { reason: "Session stopped", exitKind: "graceful" },
        providerRefs: {},
      });
    }
  });

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "unsupported" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput: (threadId, requestId, answers: ProviderUserInputAnswers) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "AskUserQuestion/respond",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        const normalized = normalizeClaudeAskUserQuestionAnswers(pending.questions, answers);
        if (!normalized) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToUserInput",
            issue: "Claude requires one non-empty answer for every question.",
          });
        }
        yield* Effect.tryPromise({
          try: () => pending.complete({ _tag: "answered", answers: normalized }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "AskUserQuestion/respond",
              detail: "Failed to resolve Claude's pending question.",
              cause,
            }),
        });
      }),
    stopSession: (threadId) =>
      requireSession(threadId).pipe(
        Effect.flatMap((context) => stopSessionInternal(context, true)),
      ),
    listSessions: () =>
      Effect.sync(() => [...sessionsByThread.values()].map((context) => ({ ...context.session }))),
    hasSession: (threadId) =>
      Effect.sync(() => {
        const context = sessionsByThread.get(threadId);
        return context !== undefined && !context.stopped;
      }),
    readThread: (threadId) =>
      requireSession(threadId).pipe(
        Effect.map((context) => ({
          threadId,
          turns: context.turns.map((turn) => ({ id: turn.turnId, items: [...turn.items] })),
        })),
      ),
    rollbackThread: (threadId, numTurns) =>
      requireSession(threadId).pipe(
        Effect.map((context) => {
          context.turns.splice(Math.max(0, context.turns.length - numTurns));
          updateResumeCursor(context);
          return {
            threadId,
            turns: context.turns.map((turn) => ({ id: turn.turnId, items: [...turn.items] })),
          };
        }),
      ),
    stopAll: () =>
      Effect.forEach(
        [...sessionsByThread.values()],
        (context) => stopSessionInternal(context, true),
        {
          discard: true,
        },
      ),
    streamEvents: Stream.fromPubSub(eventBus),
  };

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* adapter.stopAll().pipe(Effect.ignore);
      yield* PubSub.shutdown(eventBus);
    }),
  );

  return adapter;
});
