import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  ClaudeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeTimersPromises from "node:timers/promises";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as PtyAdapter from "../../terminal/PtyAdapter.ts";
import type { ClaudeHookInput, ClaudeHookResponse } from "./ClaudeHookServer.ts";
import {
  makeClaudePtyAdapter,
  type ClaudePtyAdapterOptions,
  type ClaudeRawTerminalRegistration,
} from "./ClaudePtyAdapter.ts";
import type { ClaudeTranscriptTailer } from "./ClaudeTranscriptTailer.ts";
import type { ClaudeTranscriptCursor } from "./ClaudePtyProtocol.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const THREAD_ID = ThreadId.make("thread-claude-pty");
const INSTANCE_ID = ProviderInstanceId.make("claudePty");

class FakePtyProcess implements PtyAdapter.PtyProcess {
  readonly pid = 4242;
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  readonly kills: Array<string | undefined> = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();

  write(data: string): void {
    this.writes.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  kill(signal?: string): void {
    this.kills.push(signal);
  }
  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => this.dataListeners.delete(callback);
  }
  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => this.exitListeners.delete(callback);
  }
  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
  emitExit(event: PtyAdapter.PtyExitEvent): void {
    for (const listener of this.exitListeners) listener(event);
  }
}

function transcriptPath(sessionId: string): string {
  return `/tmp/claude-home/.claude/projects/-repo/${sessionId}.jsonl`;
}

function makeHarness(overrides: Partial<ClaudePtyAdapterOptions> = {}) {
  const process = new FakePtyProcess();
  const spawns: PtyAdapter.PtySpawnInput[] = [];
  let onHook: ((hook: ClaudeHookInput) => Promise<ClaudeHookResponse>) | undefined;
  let onTranscriptRecord: ((record: Record<string, unknown>) => void | Promise<void>) | undefined;
  let transcriptPolls = 0;
  const rawRegistrations: ClaudeRawTerminalRegistration[] = [];
  const initialTranscriptCursors: Array<ClaudeTranscriptCursor | undefined> = [];

  const options: ClaudePtyAdapterOptions = {
    instanceId: INSTANCE_ID,
    environment: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "not-for-interactive" },
    idFactory: (() => {
      let next = 0;
      return () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
    })(),
    now: (() => {
      let next = 0;
      return () => `2026-07-14T12:00:${String(next++).padStart(2, "0")}.000Z`;
    })(),
    hookServerFactory: async (input) => {
      onHook = input.onHook;
      return { url: "http://127.0.0.1:43210/hooks", close: async () => {} };
    },
    transcriptTailerFactory: (input) => {
      onTranscriptRecord = input.onRecord;
      initialTranscriptCursors.push(input.initialCursor);
      return {
        close: () => {},
        pollNow: async () => {
          transcriptPolls += 1;
        },
        getCursor: () => input.initialCursor ?? { offset: 0, pending: new Uint8Array() },
      } satisfies ClaudeTranscriptTailer;
    },
    registerRawTerminal: async (input) => {
      rawRegistrations.push(input);
    },
    readinessTimeoutMs: 1_000,
    approvalTimeoutMs: 1_000,
    shutdownGraceMs: 1,
    ...overrides,
  };
  const ptyLayer = Layer.succeed(PtyAdapter.PtyAdapter, {
    spawn: (input) => {
      spawns.push(input);
      return Effect.succeed(process);
    },
  });

  return {
    process,
    spawns,
    rawRegistrations,
    getOnHook: () => onHook,
    getOnTranscriptRecord: () => onTranscriptRecord,
    getTranscriptPolls: () => transcriptPolls,
    initialTranscriptCursors,
    make: makeClaudePtyAdapter(
      decodeClaudeSettings({ homePath: "/tmp/claude-home", launchArgs: "--chrome" }),
      options,
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, ptyLayer))),
  };
}

const settle = Effect.yieldNow.pipe(Effect.andThen(Effect.yieldNow));
const sleepReal = (milliseconds: number) => NodeTimersPromises.setTimeout(milliseconds);

describe("ClaudePtyAdapter", () => {
  it.effect("starts an interactive PTY, waits for SessionStart, and tails semantic JSONL", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* harness.make;
      const events: ProviderRuntimeEvent[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkScoped,
      );

      const startFiber = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudePty"),
          providerInstanceId: INSTANCE_ID,
          cwd: "/repo",
          runtimeMode: "approval-required",
        })
        .pipe(Effect.forkScoped);
      yield* settle;

      assert.equal(harness.spawns.length, 1);
      const spawn = harness.spawns[0]!;
      assert.equal(spawn.shell, "claude");
      assert.notInclude(spawn.args ?? [], "-p");
      assert.equal(spawn.env.ANTHROPIC_API_KEY, undefined);
      const sessionId = spawn.args?.[(spawn.args?.indexOf("--session-id") ?? -1) + 1] as string;
      assert.isString(sessionId);
      yield* Effect.promise(() =>
        harness.getOnHook()!({
          hook_event_name: "SessionStart",
          session_id: sessionId,
          transcript_path: transcriptPath(sessionId),
          cwd: "/repo",
        }),
      );

      const session = yield* Fiber.join(startFiber);
      assert.equal(session.status, "ready");
      assert.equal(
        session.resumeCursor &&
          (session.resumeCursor as { nativeSessionId: string }).nativeSessionId,
        sessionId,
      );
      assert.equal(harness.rawRegistrations.length, 1);
      assert.strictEqual(harness.rawRegistrations[0]!.process, harness.process);

      const turn = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello" });
      assert.equal(harness.process.writes.at(-1), "\u001b[200~hello\u001b[201~\r");
      yield* Effect.promise(async () => {
        await harness.getOnTranscriptRecord()!({
          type: "user",
          uuid: "user-1",
          message: { content: [{ type: "text", text: "hello" }] },
        });
        await harness.getOnTranscriptRecord()!({
          type: "assistant",
          uuid: "assistant-1",
          message: {
            content: [
              { type: "text", text: "Hi" },
              { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
            ],
            usage: { input_tokens: 3, output_tokens: 2 },
          },
        });
        await harness.getOnTranscriptRecord()!({
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "tool-1", content: "/repo", is_error: false },
            ],
          },
        });
        await harness.getOnHook()!({
          hook_event_name: "Stop",
          session_id: sessionId,
          transcript_path: transcriptPath(sessionId),
          cwd: "/repo",
        });
      });
      yield* settle;

      assert.isTrue(
        events.some(
          (event) => event.type === "session.state.changed" && event.payload.state === "ready",
        ),
      );
      assert.isTrue(
        events.some((event) => event.type === "content.delta" && event.payload.delta === "Hi"),
      );
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "item.started" && event.payload.itemType === "command_execution",
        ),
      );
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "item.completed" &&
            event.providerRefs?.providerItemId === "tool-1" &&
            event.payload.itemType === "command_execution",
        ),
      );
      assert.isTrue(
        events.some((event) => event.type === "turn.completed" && event.turnId === turn.turnId),
      );
      assert.isAtLeast(harness.getTranscriptPolls(), 1);
    }).pipe(Effect.scoped);
  });

  it.effect("keeps approval HTTP pending until the canonical request is resolved", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* harness.make;
      const events: ProviderRuntimeEvent[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkScoped,
      );
      const startFiber = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudePty"),
          cwd: "/repo",
          runtimeMode: "approval-required",
        })
        .pipe(Effect.forkScoped);
      yield* settle;
      const spawn = harness.spawns[0]!;
      const sessionId = spawn.args?.[(spawn.args?.indexOf("--session-id") ?? -1) + 1] as string;
      yield* Effect.promise(() =>
        harness.getOnHook()!({
          hook_event_name: "SessionStart",
          session_id: sessionId,
          transcript_path: transcriptPath(sessionId),
          cwd: "/repo",
        }),
      );
      yield* Fiber.join(startFiber);
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "run pwd" });

      const approval = harness.getOnHook()!({
        hook_event_name: "PermissionRequest",
        session_id: sessionId,
        transcript_path: transcriptPath(sessionId),
        cwd: "/repo",
        tool_name: "Bash",
        tool_input: { command: "pwd" },
      });
      yield* settle;
      const opened = events.find((event) => event.type === "request.opened");
      assert.isDefined(opened?.requestId);
      yield* adapter.respondToRequest(
        THREAD_ID,
        ApprovalRequestId.make(opened!.requestId!),
        "accept",
      );
      const response = yield* Effect.promise(() => approval);

      assert.deepEqual(response, {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow", updatedInput: { command: "pwd" } },
        },
      });
      assert.equal(
        harness.process.writes.filter((write) => write === "y" || write === "n").length,
        0,
      );
      assert.isTrue(
        events.some(
          (event) => event.type === "request.resolved" && event.payload.decision === "accept",
        ),
      );

      const deniedHook = harness.getOnHook()!({
        hook_event_name: "PermissionRequest",
        session_id: sessionId,
        transcript_path: transcriptPath(sessionId),
        cwd: "/repo",
        tool_name: "Bash",
        tool_input: { command: "git status" },
      });
      yield* settle;
      const deniedRequest = events.findLast((event) => event.type === "request.opened");
      yield* adapter.respondToRequest(
        THREAD_ID,
        ApprovalRequestId.make(deniedRequest!.requestId!),
        "decline",
      );
      const deniedResponse = yield* Effect.promise(() => deniedHook);
      assert.equal(
        (
          deniedResponse.hookSpecificOutput as {
            readonly decision: { readonly behavior: string };
          }
        ).decision.behavior,
        "deny",
      );

      const sessionHook = harness.getOnHook()!({
        hook_event_name: "PermissionRequest",
        session_id: sessionId,
        transcript_path: transcriptPath(sessionId),
        cwd: "/repo",
        tool_name: "Read",
        tool_input: { file_path: "/repo/README.md" },
        permission_suggestions: [{ type: "addRules", rules: ["Read"] }],
      });
      yield* settle;
      const sessionRequest = events.findLast((event) => event.type === "request.opened");
      yield* adapter.respondToRequest(
        THREAD_ID,
        ApprovalRequestId.make(sessionRequest!.requestId!),
        "acceptForSession",
      );
      const sessionResponse = yield* Effect.promise(() => sessionHook);
      assert.deepEqual(
        (
          sessionResponse.hookSpecificOutput as {
            readonly decision: { readonly updatedPermissions?: readonly unknown[] };
          }
        ).decision.updatedPermissions,
        [{ type: "addRules", rules: ["Read"] }],
      );
    }).pipe(Effect.scoped);
  });

  it.effect("resumes the native session at a durable transcript offset without replay", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* harness.make;
      const events: ProviderRuntimeEvent[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkScoped,
      );
      const nativeSessionId = "11111111-1111-4111-8111-111111111111";
      const startFiber = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudePty"),
          providerInstanceId: INSTANCE_ID,
          cwd: "/repo",
          runtimeMode: "approval-required",
          resumeCursor: {
            schemaVersion: 1,
            nativeSessionId,
            providerInstanceId: INSTANCE_ID,
            homeIdentity: "/tmp/claude-home",
            transcriptPath: transcriptPath(nativeSessionId),
            transcriptOffset: 512,
            turnCount: 3,
          },
        })
        .pipe(Effect.forkScoped);
      yield* settle;
      assert.include(harness.spawns[0]!.args ?? [], "--resume");
      assert.notInclude(harness.spawns[0]!.args ?? [], "--session-id");
      assert.deepEqual(harness.initialTranscriptCursors[0], {
        offset: 512,
        pending: new Uint8Array(),
      });
      yield* Effect.promise(() =>
        harness.getOnHook()!({
          hook_event_name: "SessionStart",
          session_id: nativeSessionId,
          transcript_path: transcriptPath(nativeSessionId),
          cwd: "/repo",
        }),
      );
      yield* Fiber.join(startFiber);
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "continue" });
      const finalRecord = {
        type: "assistant",
        uuid: "assistant-resumed",
        message: {
          content: [{ type: "text", text: "continued" }],
          stop_reason: "end_turn",
        },
      };
      yield* Effect.promise(async () => {
        await harness.getOnTranscriptRecord()!({
          type: "user",
          uuid: "user-resumed",
          message: { content: [{ type: "text", text: "continue" }] },
        });
        await harness.getOnTranscriptRecord()!(finalRecord);
        await harness.getOnTranscriptRecord()!(finalRecord);
      });
      yield* settle;

      assert.equal(
        events.filter(
          (event) => event.type === "content.delta" && event.payload.delta === "continued",
        ).length,
        1,
      );
      assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
    }).pipe(Effect.scoped);
  });

  it.effect("does not complete a stopped turn while a transcript tool is unresolved", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* harness.make;
      const events: ProviderRuntimeEvent[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkScoped,
      );
      const startFiber = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudePty"),
          cwd: "/repo",
          runtimeMode: "approval-required",
        })
        .pipe(Effect.forkScoped);
      yield* settle;
      const spawn = harness.spawns[0]!;
      const sessionId = spawn.args?.[(spawn.args?.indexOf("--session-id") ?? -1) + 1] as string;
      yield* Effect.promise(() =>
        harness.getOnHook()!({
          hook_event_name: "SessionStart",
          session_id: sessionId,
          transcript_path: transcriptPath(sessionId),
          cwd: "/repo",
        }),
      );
      yield* Fiber.join(startFiber);
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "tool" });
      yield* Effect.promise(async () => {
        await harness.getOnTranscriptRecord()!({
          type: "user",
          uuid: "user-tool",
          message: { content: [{ type: "text", text: "tool" }] },
        });
        await harness.getOnTranscriptRecord()!({
          type: "assistant",
          uuid: "assistant-tool",
          message: {
            content: [{ type: "tool_use", id: "tool-long", name: "Bash", input: {} }],
            stop_reason: "tool_use",
          },
        });
        await harness.getOnHook()!({
          hook_event_name: "Stop",
          session_id: sessionId,
          transcript_path: transcriptPath(sessionId),
          cwd: "/repo",
        });
      });
      assert.equal(events.filter((event) => event.type === "turn.completed").length, 0);

      yield* Effect.promise(async () => {
        await harness.getOnTranscriptRecord()!({
          type: "user",
          uuid: "result-tool",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "tool-long", content: "done", is_error: false },
            ],
          },
        });
      });
      yield* settle;
      assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
    }).pipe(Effect.scoped);
  });

  it.effect("preserves an unready PTY as a raw attention surface", () => {
    const harness = makeHarness({ readinessTimeoutMs: 2 });
    return Effect.gen(function* () {
      const adapter = yield* harness.make;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudePty"),
        cwd: "/repo",
        runtimeMode: "approval-required",
      });

      assert.equal(session.status, "error");
      assert.match(session.lastError ?? "", /raw Claude session/i);
      assert.equal(harness.rawRegistrations.length, 1);
      assert.deepEqual(harness.process.kills, []);
      const rejected = yield* adapter
        .sendTurn({ threadId: THREAD_ID, input: "do not paste yet" })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(rejected));

      const sessionId = harness.spawns[0]!.args?.[
        (harness.spawns[0]!.args?.indexOf("--session-id") ?? -1) + 1
      ] as string;
      yield* Effect.promise(() =>
        harness.getOnHook()!({
          hook_event_name: "SessionStart",
          session_id: sessionId,
          transcript_path: transcriptPath(sessionId),
          cwd: "/repo",
        }),
      );
      const sessions = yield* adapter.listSessions();
      assert.equal(sessions[0]?.status, "ready");
    }).pipe(Effect.scoped);
  });

  it.effect("queues exactly one turn and distinguishes an interrupted outcome", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* harness.make;
      const events: ProviderRuntimeEvent[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkScoped,
      );
      const startFiber = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudePty"),
          cwd: "/repo",
          runtimeMode: "approval-required",
        })
        .pipe(Effect.forkScoped);
      yield* settle;
      const spawn = harness.spawns[0]!;
      const sessionId = spawn.args?.[(spawn.args?.indexOf("--session-id") ?? -1) + 1] as string;
      yield* Effect.promise(() =>
        harness.getOnHook()!({
          hook_event_name: "SessionStart",
          session_id: sessionId,
          transcript_path: transcriptPath(sessionId),
          cwd: "/repo",
        }),
      );
      yield* Fiber.join(startFiber);
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "first" });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "second" });
      const third = yield* adapter
        .sendTurn({ threadId: THREAD_ID, input: "third" })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(third));
      assert.equal(harness.process.writes.filter((write) => write.includes("second")).length, 0);

      yield* adapter.interruptTurn(THREAD_ID);
      assert.equal(harness.process.writes.at(-1), "\u0003");
      yield* Effect.promise(async () => {
        await harness.getOnTranscriptRecord()!({
          type: "user",
          uuid: "user-first",
          message: { content: [{ type: "text", text: "first" }] },
        });
        await harness.getOnHook()!({
          hook_event_name: "Stop",
          session_id: sessionId,
          transcript_path: transcriptPath(sessionId),
          cwd: "/repo",
        });
      });
      yield* settle;

      assert.isTrue(harness.process.writes.some((write) => write.includes("second")));
      assert.isTrue(
        events.some(
          (event) => event.type === "turn.completed" && event.payload.state === "interrupted",
        ),
      );
    }).pipe(Effect.scoped);
  });

  it.effect("times out an unanswered approval closed and rejects duplicate decisions", () => {
    const harness = makeHarness({ approvalTimeoutMs: 5 });
    return Effect.gen(function* () {
      const adapter = yield* harness.make;
      const events: ProviderRuntimeEvent[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkScoped,
      );
      const startFiber = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudePty"),
          cwd: "/repo",
          runtimeMode: "approval-required",
        })
        .pipe(Effect.forkScoped);
      yield* settle;
      const spawn = harness.spawns[0]!;
      const sessionId = spawn.args?.[(spawn.args?.indexOf("--session-id") ?? -1) + 1] as string;
      yield* Effect.promise(() =>
        harness.getOnHook()!({
          hook_event_name: "SessionStart",
          session_id: sessionId,
          transcript_path: transcriptPath(sessionId),
          cwd: "/repo",
        }),
      );
      yield* Fiber.join(startFiber);
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "run" });
      const approval = harness.getOnHook()!({
        hook_event_name: "PermissionRequest",
        session_id: sessionId,
        transcript_path: transcriptPath(sessionId),
        cwd: "/repo",
        tool_name: "Bash",
        tool_input: { command: "pwd" },
      });
      const response = yield* Effect.promise(() => approval);
      assert.equal(
        (
          response.hookSpecificOutput as {
            readonly decision: { readonly behavior: string };
          }
        ).decision.behavior,
        "deny",
      );
      const resolved = events.find(
        (event) => event.type === "request.resolved" && event.payload.decision === "cancel",
      );
      assert.isDefined(resolved?.requestId);
      const duplicate = yield* adapter
        .respondToRequest(THREAD_ID, ApprovalRequestId.make(resolved!.requestId!), "accept")
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(duplicate));
    }).pipe(Effect.scoped);
  });

  it.effect("emits a recoverable runtime error when the Claude process exits", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* harness.make;
      const events: ProviderRuntimeEvent[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkScoped,
      );
      const startFiber = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudePty"),
          cwd: "/repo",
          runtimeMode: "approval-required",
        })
        .pipe(Effect.forkScoped);
      yield* settle;
      const spawn = harness.spawns[0]!;
      const sessionId = spawn.args?.[(spawn.args?.indexOf("--session-id") ?? -1) + 1] as string;
      yield* Effect.promise(() =>
        harness.getOnHook()!({
          hook_event_name: "SessionStart",
          session_id: sessionId,
          transcript_path: transcriptPath(sessionId),
          cwd: "/repo",
        }),
      );
      yield* Fiber.join(startFiber);
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "working" });
      harness.process.emitExit({ exitCode: 17, signal: null });
      yield* settle;

      assert.isTrue(events.some((event) => event.type === "runtime.error"));
      assert.isTrue(
        events.some((event) => event.type === "turn.completed" && event.payload.state === "failed"),
      );
      assert.isTrue(events.some((event) => event.type === "session.exited"));
      assert.isFalse(yield* adapter.hasSession(THREAD_ID));
    }).pipe(Effect.scoped);
  });

  it.effect("warns on no acknowledgement and fails a hard-timed-out turn", () => {
    const harness = makeHarness({ noOutputWarningMs: 3, hardTurnTimeoutMs: 8 });
    return Effect.gen(function* () {
      const adapter = yield* harness.make;
      const events: ProviderRuntimeEvent[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkScoped,
      );
      const startFiber = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudePty"),
          cwd: "/repo",
          runtimeMode: "approval-required",
        })
        .pipe(Effect.forkScoped);
      yield* settle;
      const spawn = harness.spawns[0]!;
      const sessionId = spawn.args?.[(spawn.args?.indexOf("--session-id") ?? -1) + 1] as string;
      yield* Effect.promise(() =>
        harness.getOnHook()!({
          hook_event_name: "SessionStart",
          session_id: sessionId,
          transcript_path: transcriptPath(sessionId),
          cwd: "/repo",
        }),
      );
      yield* Fiber.join(startFiber);
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "stuck" });
      yield* Effect.promise(() => sleepReal(20));

      assert.isTrue(events.some((event) => event.type === "runtime.warning"));
      assert.isTrue(events.some((event) => event.type === "runtime.error"));
      assert.isTrue(
        events.some((event) => event.type === "turn.completed" && event.payload.state === "failed"),
      );
      assert.include(harness.process.writes, "\u0003");
    }).pipe(Effect.scoped);
  });

  it.effect("launches plan mode and materializes attachment paths into the prompt", () => {
    const harness = makeHarness({
      resolveAttachmentPath: (attachment) => `/tmp/attachments/${attachment.id}`,
    });
    return Effect.gen(function* () {
      const adapter = yield* harness.make;
      const startFiber = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudePty"),
          cwd: "/repo",
          runtimeMode: "approval-required",
          interactionMode: "plan",
        })
        .pipe(Effect.forkScoped);
      yield* settle;
      const spawn = harness.spawns[0]!;
      const sessionId = spawn.args?.[(spawn.args?.indexOf("--session-id") ?? -1) + 1] as string;
      assert.equal(spawn.args?.[(spawn.args?.indexOf("--permission-mode") ?? -1) + 1], "plan");
      yield* Effect.promise(() =>
        harness.getOnHook()!({
          hook_event_name: "SessionStart",
          session_id: sessionId,
          transcript_path: transcriptPath(sessionId),
          cwd: "/repo",
        }),
      );
      yield* Fiber.join(startFiber);
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        interactionMode: "plan",
        attachments: [
          {
            type: "image",
            id: "image-1",
            name: "diagram.png",
            mimeType: "image/png",
            sizeBytes: 10,
          },
        ],
      });
      assert.match(harness.process.writes.at(-1) ?? "", /\/tmp\/attachments\/image-1/u);
      yield* Effect.promise(async () => {
        await harness.getOnTranscriptRecord()!({
          type: "user",
          uuid: "user-attachment",
          message: {
            content: [
              {
                type: "text",
                text: "[Attached image: diagram.png (image/png) at /tmp/attachments/image-1]",
              },
            ],
          },
        });
        await harness.getOnTranscriptRecord()!({
          type: "assistant",
          uuid: "assistant-attachment",
          message: { content: [{ type: "text", text: "seen" }], stop_reason: "end_turn" },
        });
      });
      const switchMode = yield* adapter
        .sendTurn({ threadId: THREAD_ID, input: "switch", interactionMode: "default" })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(switchMode));
    }).pipe(Effect.scoped);
  });
});
