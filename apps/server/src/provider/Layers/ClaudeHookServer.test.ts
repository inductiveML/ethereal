// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import { describe, expect, it, vi } from "vite-plus/test";

import { dispatchClaudeHookRequest, startClaudeHookServer } from "./ClaudeHookServer.ts";

function postJson(
  url: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ readonly status: number; readonly body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = NodeHttp.request(
      url,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      },
      (response) => {
        const chunks: Uint8Array[] = [];
        response.on("data", (chunk: Uint8Array) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          const responseBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
          resolve({ status: response.statusCode ?? 0, body: responseBody });
        });
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

describe("dispatchClaudeHookRequest", () => {
  it("rejects requests without the session secret before parsing hook data", async () => {
    const onHook = vi.fn();
    const result = await dispatchClaudeHookRequest(
      {
        method: "POST",
        authorization: "Bearer wrong",
        body: new TextEncoder().encode('{"hook_event_name":"SessionStart"}'),
      },
      { token: "secret", onHook },
    );

    expect(result).toEqual({ status: 401, body: { error: "Unauthorized" } });
    expect(onHook).not.toHaveBeenCalled();
  });

  it("dispatches a bounded JSON hook body and returns its blocking decision", async () => {
    const onHook = vi.fn(async () => ({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    }));
    const hook = {
      session_id: "session-1",
      transcript_path: "/home/.claude/session.jsonl",
      cwd: "/repo",
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "pwd" },
    };
    const result = await dispatchClaudeHookRequest(
      {
        method: "POST",
        authorization: "Bearer secret",
        body: new TextEncoder().encode(JSON.stringify(hook)),
      },
      { token: "secret", onHook },
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual(await onHook.mock.results[0]!.value);
    expect(onHook).toHaveBeenCalledWith(hook);
  });

  it("fails closed on oversized or malformed requests", async () => {
    const onHook = vi.fn();
    const oversized = await dispatchClaudeHookRequest(
      {
        method: "POST",
        authorization: "Bearer secret",
        body: new Uint8Array(1_048_577),
      },
      { token: "secret", onHook },
    );
    const malformed = await dispatchClaudeHookRequest(
      {
        method: "POST",
        authorization: "Bearer secret",
        body: new TextEncoder().encode("not-json"),
      },
      { token: "secret", onHook },
    );

    expect(oversized.status).toBe(413);
    expect(malformed.status).toBe(400);
    expect(onHook).not.toHaveBeenCalled();
  });

  it("rejects a valid token from a different Claude session", async () => {
    const onHook = vi.fn();
    const result = await dispatchClaudeHookRequest(
      {
        method: "POST",
        authorization: "Bearer secret",
        body: new TextEncoder().encode(
          JSON.stringify({ hook_event_name: "Stop", session_id: "other-session" }),
        ),
      },
      { token: "secret", sessionId: "expected-session", onHook },
    );

    expect(result).toEqual({ status: 403, body: { error: "Unknown Claude session" } });
    expect(onHook).not.toHaveBeenCalled();
  });

  it("binds an authenticated blocking endpoint on loopback", async () => {
    const onHook = vi.fn(async () => ({ continue: true }));
    const server = await startClaudeHookServer({
      token: "secret",
      sessionId: "session-1",
      onHook,
    });
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hooks$/u);
      const response = await postJson(server.url, "secret", {
        hook_event_name: "Stop",
        session_id: "session-1",
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ continue: true });
      expect(onHook).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });
});
