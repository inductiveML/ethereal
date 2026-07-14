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
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
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
  durableClaudeTranscriptOffset,
  encodeClaudeBracketedPaste,
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

const PROVIDER = ProviderDriverKind.make("claudePty");
const DEFAULT_INSTANCE_ID = ProviderInstanceId.make("claudePty");
const RAW_TERMINAL_ID = "claude-pty-raw";
const HOOK_TOKEN_ENV = "ETHEREAL_CLAUDE_HOOK_TOKEN";
const CTRL_C = "\u0003";

interface PendingApproval {
  readonly requestId: ApprovalRequestId;
  readonly requestType: CanonicalRequestType;
  readonly complete: (decision: ProviderApprovalDecision) => Promise<void>;
}

interface ClaudePtyTurn {
  readonly turnId: TurnId;
  readonly prompt: string;
  readonly startedAt: string;
  readonly items: unknown[];
  readonly toolItems: Map<
    string,
    { readonly itemId: RuntimeItemId; readonly itemType: CanonicalItemType }
  >;
  readonly assistantItems: Set<string>;
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
}

export interface ClaudeRawTerminalRegistration {
  readonly threadId: ThreadId;
  readonly terminalId: string;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly label: string;
  readonly process: PtyAdapter.PtyProcess;
}

export interface ClaudePtyAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly idFactory?: () => string;
  readonly now?: () => string;
  readonly hookServerFactory?: ClaudeHookServerFactory;
  readonly transcriptTailerFactory?: typeof startClaudeTranscriptTailer;
  readonly registerRawTerminal?: (input: ClaudeRawTerminalRegistration) => Promise<void>;
  readonly readinessTimeoutMs?: number;
  readonly approvalTimeoutMs?: number;
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
  const approvalTimeoutMs = options.approvalTimeoutMs ?? 120_000;
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

  const handleSemanticEvent = Effect.fn("claudePty.handleSemanticEvent")(function* (
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
      yield* maybeCompleteTurn(context);
      return;
    }
    if (semantic.type === "assistant-stop") {
      if (semantic.reason !== "tool_use") turn.stopSeen = true;
      yield* maybeCompleteTurn(context);
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
      yield* maybeCompleteTurn(context);
      return;
    }
    if (semantic.type === "tool-started") {
      const itemId = RuntimeItemId.make(`tool-${semantic.toolUseId}`);
      turn.toolItems.set(semantic.toolUseId, { itemId, itemType: semantic.itemType });
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
          data: { output: semantic.content },
        },
        providerRefs: { providerItemId: ProviderItemId.make(semantic.toolUseId) },
        raw,
      });
      turn.toolItems.delete(semantic.toolUseId);
      turn.items.push(semantic);
      yield* maybeCompleteTurn(context);
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
    yield* maybeCompleteTurn(context);
  });

  const handleTranscriptRecord = Effect.fn("claudePty.handleTranscriptRecord")(function* (
    context: ClaudePtySessionContext,
    record: Record<string, unknown>,
  ) {
    if (context.stopped) return;
    for (const semantic of parseClaudeTranscriptRecord(record)) {
      yield* handleSemanticEvent(context, semantic, record);
    }
  });

  const completeTurn = Effect.fn("claudePty.completeTurn")(function* (
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

  const maybeCompleteTurn = Effect.fn("claudePty.maybeCompleteTurn")(function* (
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
              "Claude has not acknowledged the submitted prompt. Open the raw Claude session to inspect login, trust, update, or onboarding state.",
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

  const beginTurn = Effect.fn("claudePty.beginTurn")(function* (
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
      try: () => process.write(encodeClaudeBracketedPaste(prompt)),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: "Failed to write the prompt to the Claude PTY.",
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

  const handlePermissionRequest = Effect.fn("claudePty.handlePermissionRequest")(function* (
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

  const handleHook = Effect.fn("claudePty.handleHook")(function* (hook: ClaudeHookInput) {
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
        return {};
      }
      case "PermissionRequest":
        return yield* handlePermissionRequest(context, hook);
      case "Stop":
        context.readiness = advanceClaudePtyReadiness(context.readiness, {
          type: "hook",
          event: "Stop",
        });
        if (context.currentTurn) context.currentTurn.stopSeen = true;
        if (context.transcriptTailer) {
          yield* Effect.promise(() => context.transcriptTailer!.pollNow());
        }
        yield* maybeCompleteTurn(context);
        return {};
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

  const handleProcessExit = Effect.fn("claudePty.handleProcessExit")(function* (
    context: ClaudePtySessionContext,
    event: PtyAdapter.PtyExitEvent,
  ) {
    if (context.stopped) return;
    context.stopped = true;
    context.readiness = advanceClaudePtyReadiness(context.readiness, {
      type: "process-exit",
      reason: `Claude exited with code ${event.exitCode}.`,
    });
    context.resolveExit(event);
    context.rejectReady(new Error(`Claude exited with code ${event.exitCode}.`));
    context.transcriptTailer?.close();
    yield* Effect.promise(() => resolveAllApprovals(context, "cancel"));
    if (context.currentTurn) {
      yield* completeTurn(
        context,
        context.currentTurn.interruptRequested || event.exitCode === 0 ? "interrupted" : "failed",
      );
    }
    context.session = {
      ...context.session,
      status: event.exitCode === 0 ? "closed" : "error",
      activeTurnId: undefined,
      updatedAt: now(),
      ...(event.exitCode === 0 ? {} : { lastError: `Claude exited with code ${event.exitCode}.` }),
    };
    if (!context.stopping || event.exitCode !== 0) {
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
        reason: `Claude exited with code ${event.exitCode}.`,
        exitKind: event.exitCode === 0 ? "graceful" : "error",
        recoverable: true,
      },
      providerRefs: {},
    });
    sessionsByThread.delete(context.session.threadId);
    sessionsByClaudeId.delete(context.sessionId);
    if (context.hookServer) {
      yield* Effect.tryPromise(() => context.hookServer!.close()).pipe(Effect.ignore);
      context.hookServer = undefined;
    }
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
    "claudePty.startSession",
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
          sessionsByThread.delete(input.threadId);
          sessionsByClaudeId.delete(sessionId);
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
            sessionsByThread.delete(input.threadId);
            sessionsByClaudeId.delete(sessionId);
          }),
        ),
      );
    context.process = spawned;
    context.readiness = advanceClaudePtyReadiness(context.readiness, { type: "spawned" });
    context.unsubscribeData = spawned.onData((data) => {
      context.readiness = advanceClaudePtyReadiness(context.readiness, {
        type: "pty-output",
        data,
      });
    });
    context.unsubscribeExit = spawned.onExit((event) => {
      void runPromise(handleProcessExit(context, event));
    });
    if (options.registerRawTerminal) {
      yield* Effect.tryPromise({
        try: () =>
          options.registerRawTerminal!({
            threadId: input.threadId,
            terminalId: RAW_TERMINAL_ID,
            cwd: launch.cwd,
            cols: 120,
            rows: 36,
            label: "Claude raw session",
            process: spawned,
          }),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: "Failed to register the raw Claude PTY terminal.",
            cause,
          }),
      }).pipe(Effect.tapError(() => stopSessionInternal(context, false)));
    }
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
          rawTerminalId: RAW_TERMINAL_ID,
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
          "Claude did not report a ready session. Open the raw Claude session to complete login, trust, update, or onboarding.",
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
    "claudePty.sendTurn",
  )(function* (input) {
    const context = yield* requireSession(input.threadId);
    if (!context.currentTurn && context.readiness.state !== "ready") {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail:
          "Claude is not ready for native composer input. Open the raw Claude session and resolve the attention state first.",
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
    "claudePty.interruptTurn",
  )(function* (threadId) {
    const context = yield* requireSession(threadId);
    if (!context.process) return;
    if (context.currentTurn) context.currentTurn.interruptRequested = true;
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
    Effect.fn("claudePty.respondToRequest")(function* (threadId, requestId, decision) {
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

  const stopSessionInternal = Effect.fn("claudePty.stopSessionInternal")(function* (
    context: ClaudePtySessionContext,
    emitExit: boolean,
  ) {
    if (context.stopped) return;
    if (context.stopping) {
      return;
    }
    context.stopping = true;
    yield* Effect.promise(() => resolveAllApprovals(context, "cancel"));
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
      bestEffortProcessWrite(context.process, encodeClaudeBracketedPaste("/exit"));
      if (yield* Effect.promise(() => waitForExit(shutdownGraceMs))) return;
      bestEffortProcessKill(context.process, "SIGTERM");
      if (yield* Effect.promise(() => waitForExit(Math.min(shutdownGraceMs, 500)))) return;
      bestEffortProcessKill(context.process, "SIGKILL");
    }
    context.stopped = true;
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
    sessionsByThread.delete(context.session.threadId);
    sessionsByClaudeId.delete(context.sessionId);
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
    respondToUserInput: (threadId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "item/tool/respondToUserInput",
          detail: `Claude PTY structured user input is not available for thread ${threadId}.`,
        }),
      ),
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
