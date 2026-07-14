import { describe, expect, it } from "vite-plus/test";

import {
  advanceClaudePtyReadiness,
  buildClaudePtyLaunchSpec,
  consumeClaudeTranscriptBytes,
  encodeClaudeBracketedPaste,
  initialClaudePtyReadiness,
  initialClaudeTranscriptCursor,
  parseClaudePtyCapabilities,
  parseClaudeTranscriptRecord,
} from "./ClaudePtyProtocol.ts";

describe("ClaudePtyProtocol", () => {
  it("derives versioned interactive capabilities without running a prompt", () => {
    expect(
      parseClaudePtyCapabilities({
        versionOutput: "2.1.208 (Claude Code)",
        helpOutput:
          "--settings <file-or-json> --session-id <uuid> --resume [value] --name <name> --model <model> --permission-mode <mode> --effort <level>",
      }),
    ).toEqual({
      version: "2.1.208",
      interactive: true,
      sessionResume: true,
      modelSelection: true,
      sessionName: true,
      permissionModes: true,
      settingsInjection: true,
      httpHooks: true,
      permissionRequestHook: true,
      effort: true,
    });
  });

  it("requires prompt-id-capable hooks and the interactive manual permission mode", () => {
    const capabilities = parseClaudePtyCapabilities({
      versionOutput: "2.1.199 (Claude Code)",
      helpOutput: "--settings --session-id --resume --name --model --permission-mode",
    });

    expect(capabilities.httpHooks).toBe(false);
    expect(capabilities.permissionRequestHook).toBe(false);
  });

  it("constructs an interactive, subscription-only launch with private HTTP hooks", () => {
    const launch = buildClaudePtyLaunchSpec({
      binaryPath: "/opt/claude",
      cwd: "/work/repo",
      homePath: "/tmp/claude-home",
      sessionId: "11111111-1111-4111-8111-111111111111",
      model: "claude-sonnet-4-6",
      effort: "high",
      runtimeMode: "approval-required",
      hookUrl: "http://127.0.0.1:43210/hooks",
      hookTokenEnvironmentVariable: "ETHEREAL_CLAUDE_HOOK_TOKEN",
      baseEnvironment: {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "must-not-leak",
        ANTHROPIC_AUTH_TOKEN: "must-not-leak",
      },
      launchArgs: "--chrome",
    });

    expect(launch.command).toBe("/opt/claude");
    expect(launch.args).toContain("--session-id");
    expect(launch.args).toContain("--model");
    expect(launch.args).toContain("--effort");
    expect(launch.args).toContain("--permission-mode");
    expect(launch.args).toContain("manual");
    expect(launch.args).toContain("--settings");
    expect(launch.args).toContain("--ax-screen-reader");
    expect(launch.args).toContain("--chrome");
    expect(launch.args).not.toContain("-p");
    expect(launch.args).not.toContain("--print");
    expect(launch.environment.HOME).toBe("/tmp/claude-home");
    expect(launch.environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(launch.environment.ANTHROPIC_AUTH_TOKEN).toBeUndefined();

    const settings = JSON.parse(launch.args[launch.args.indexOf("--settings") + 1]!);
    expect(settings.hooks.PermissionRequest[0].hooks[0]).toMatchObject({
      type: "http",
      url: "http://127.0.0.1:43210/hooks",
    });
    expect(settings.hooks.Stop[0].hooks[0].headers.Authorization).toBe(
      "Bearer $ETHEREAL_CLAUDE_HOOK_TOKEN",
    );
  });

  it("uses resume instead of creating a conflicting new session id", () => {
    const launch = buildClaudePtyLaunchSpec({
      binaryPath: "claude",
      cwd: "/work/repo",
      homePath: "/tmp/home",
      sessionId: "new-id",
      resumeSessionId: "existing-id",
      runtimeMode: "full-access",
      hookUrl: "http://127.0.0.1/hooks",
      hookTokenEnvironmentVariable: "TOKEN",
      baseEnvironment: {},
      launchArgs: "",
    });

    expect(launch.args).toContain("--resume");
    expect(launch.args).toContain("existing-id");
    expect(launch.args).not.toContain("--session-id");
    expect(launch.args).toContain("bypassPermissions");
    expect(launch.args).toContain("--dangerously-skip-permissions");
  });

  it("preserves explicitly configured custom-provider credentials", () => {
    const launch = buildClaudePtyLaunchSpec({
      binaryPath: "/custom/claude",
      cwd: "/repo",
      homePath: "/accounts/router",
      sessionId: "11111111-1111-4111-8111-111111111111",
      runtimeMode: "auto-accept-edits",
      hookUrl: "http://127.0.0.1/hooks",
      hookTokenEnvironmentVariable: "TOKEN",
      baseEnvironment: {
        ANTHROPIC_API_KEY: "configured-custom-key",
        ANTHROPIC_BASE_URL: "http://router.internal",
      },
      launchArgs: "",
      subscriptionOnly: false,
    });

    expect(launch.environment.ANTHROPIC_API_KEY).toBe("configured-custom-key");
    expect(launch.environment.ANTHROPIC_BASE_URL).toBe("http://router.internal");
    expect(launch.args).toContain("acceptEdits");
  });

  it("starts plan sessions with Claude's supported plan permission mode", () => {
    const launch = buildClaudePtyLaunchSpec({
      binaryPath: "claude",
      cwd: "/repo",
      homePath: "/home",
      sessionId: "11111111-1111-4111-8111-111111111111",
      runtimeMode: "approval-required",
      interactionMode: "plan",
      hookUrl: "http://127.0.0.1/hooks",
      hookTokenEnvironmentVariable: "TOKEN",
      baseEnvironment: {},
      launchArgs: "",
    });

    expect(launch.args[launch.args.indexOf("--permission-mode") + 1]).toBe("plan");
  });

  it("rejects launch arguments that could replace Ethereal's protocol controls", () => {
    expect(() =>
      buildClaudePtyLaunchSpec({
        binaryPath: "claude",
        cwd: "/work/repo",
        homePath: "/tmp/home",
        sessionId: "id",
        runtimeMode: "approval-required",
        hookUrl: "http://127.0.0.1/hooks",
        hookTokenEnvironmentVariable: "TOKEN",
        baseEnvironment: {},
        launchArgs: "--settings ./other.json",
      }),
    ).toThrow(/reserved.*settings/i);
  });

  it("neutralizes control sequences before bracketed paste", () => {
    const encoded = encodeClaudeBracketedPaste("hello\r\nworld\u001b[201~oops\u0000");
    expect(encoded).toBe("\u001b[200~hello\nworld[201~oops\uFFFD\u001b[201~");
  });

  it.each([
    ["plain", "hello"],
    ["multiline", "one\ntwo\n```ts\nconst value = '🪶'\n```"],
    ["carriage returns", "one\rtwo\r\nthree"],
  ])("preserves safe %s prompt content", (_label, prompt) => {
    const encoded = encodeClaudeBracketedPaste(prompt);
    expect(encoded.startsWith("\u001b[200~")).toBe(true);
    expect(encoded.endsWith("\u001b[201~")).toBe(true);
    expect(encoded).not.toContain("\u0000");
  });

  it("becomes ready from Claude's screen-reader idle prompt", () => {
    const spawned = advanceClaudePtyReadiness(initialClaudePtyReadiness, { type: "spawned" });
    const output = advanceClaudePtyReadiness(spawned, {
      type: "pty-output",
      data: "[Screen Reader Mode: on via flag]\r\nClaude Code v2.1.209\r\n Ethereal\r\n$\u001b[4G",
    });
    const running = advanceClaudePtyReadiness(output, { type: "prompt-submitted" });
    const waiting = advanceClaudePtyReadiness(running, { type: "hook", event: "Stop" });

    expect(output.state).toBe("ready");
    expect(running.state).toBe("working");
    expect(waiting.state).toBe("ready");
  });

  it("rediscovers the idle prompt after an interrupt", () => {
    const working = advanceClaudePtyReadiness(
      advanceClaudePtyReadiness(initialClaudePtyReadiness, { type: "spawned" }),
      { type: "prompt-submitted" },
    );
    const interrupted = advanceClaudePtyReadiness(working, { type: "interrupt-requested" });
    const ready = advanceClaudePtyReadiness(interrupted, {
      type: "pty-output",
      data: "^C\r\n Ethereal\r\n$\u001b[4G",
    });

    expect(interrupted.lastOutput).toBe("");
    expect(ready.state).toBe("ready");
  });

  it("keeps attention states authoritative over an idle-looking prompt", () => {
    const output = advanceClaudePtyReadiness(initialClaudePtyReadiness, {
      type: "pty-output",
      data: "Press Enter to continue\r\n Ethereal\r\n$\u001b[4G",
    });

    expect(output.state).toBe("needs-attention");
  });

  it("tails JSONL by byte offset without losing split UTF-8 records", () => {
    const encoder = new TextEncoder();
    const first = encoder.encode(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hi ',
    );
    const second = encoder.encode('there 🪶"}]}}\n{"type":"system"');
    const third = encoder.encode(',"subtype":"turn_duration"}\n');

    const a = consumeClaudeTranscriptBytes(initialClaudeTranscriptCursor, first);
    const b = consumeClaudeTranscriptBytes(a.cursor, second);
    const c = consumeClaudeTranscriptBytes(b.cursor, third);

    expect(a.records).toEqual([]);
    expect(b.records).toHaveLength(1);
    expect(b.records[0]).toMatchObject({ type: "assistant" });
    expect(c.records).toEqual([{ type: "system", subtype: "turn_duration" }]);
    expect(c.cursor.offset).toBe(first.byteLength + second.byteLength + third.byteLength);
  });

  it("normalizes assistant text, tools, results, and completion records", () => {
    expect(
      parseClaudeTranscriptRecord({
        type: "assistant",
        uuid: "assistant-1",
        message: {
          content: [
            { type: "text", text: "Done" },
            { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
          ],
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      }),
    ).toEqual([
      { type: "assistant-text", messageId: "assistant-1", blockIndex: 0, text: "Done" },
      {
        type: "tool-started",
        toolUseId: "tool-1",
        toolName: "Bash",
        itemType: "command_execution",
        input: { command: "pwd" },
      },
      { type: "usage", inputTokens: 10, outputTokens: 2 },
    ]);

    expect(
      parseClaudeTranscriptRecord({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok", is_error: false }],
        },
      }),
    ).toEqual([{ type: "tool-completed", toolUseId: "tool-1", content: "ok", failed: false }]);
  });

  it("normalizes prompt acknowledgement, stop reasons, subagents, MCP, and failures", () => {
    expect(
      parseClaudeTranscriptRecord({
        type: "user",
        uuid: "user-1",
        message: {
          content: [
            { type: "text", text: "hello" },
            { type: "tool_result", tool_use_id: "tool-1", content: "failed", is_error: true },
          ],
        },
      }),
    ).toEqual([
      { type: "user-acknowledged", messageId: "user-1", text: "hello" },
      { type: "tool-completed", toolUseId: "tool-1", content: "failed", failed: true },
    ]);
    expect(
      parseClaudeTranscriptRecord({
        type: "assistant",
        uuid: "assistant-2",
        message: {
          content: [
            { type: "tool_use", id: "agent-1", name: "Agent", input: {} },
            { type: "tool_use", id: "mcp-1", name: "mcp__server__tool", input: {} },
          ],
          stop_reason: "tool_use",
        },
      }),
    ).toEqual([
      {
        type: "tool-started",
        toolUseId: "agent-1",
        toolName: "Agent",
        itemType: "collab_agent_tool_call",
        input: {},
      },
      {
        type: "tool-started",
        toolUseId: "mcp-1",
        toolName: "mcp__server__tool",
        itemType: "mcp_tool_call",
        input: {},
      },
      { type: "assistant-stop", messageId: "assistant-2", reason: "tool_use" },
    ]);
  });
});
