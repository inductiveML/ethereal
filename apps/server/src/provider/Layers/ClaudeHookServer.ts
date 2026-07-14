// @effect-diagnostics nodeBuiltinImport:off - This module is the loopback Node HTTP system boundary used by Claude hooks.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

const MAX_HOOK_BODY_BYTES = 1024 * 1024;

export interface ClaudeHookInput extends Record<string, unknown> {
  readonly hook_event_name: string;
  readonly session_id?: string;
  readonly transcript_path?: string;
  readonly cwd?: string;
  readonly tool_name?: string;
  readonly tool_use_id?: string;
  readonly tool_input?: Record<string, unknown>;
  readonly permission_suggestions?: readonly unknown[];
  readonly prompt_id?: string;
  readonly prompt?: string;
  readonly last_assistant_message?: string;
}

export type ClaudeHookResponse = Record<string, unknown>;

export interface ClaudeHookDispatchResult {
  readonly status: number;
  readonly body: ClaudeHookResponse;
}

function authorized(actual: string | undefined, token: string): boolean {
  if (!actual) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const received = Buffer.from(actual);
  return (
    received.byteLength === expected.byteLength && NodeCrypto.timingSafeEqual(received, expected)
  );
}

export async function dispatchClaudeHookRequest(
  request: {
    readonly method: string | undefined;
    readonly authorization: string | undefined;
    readonly body: Uint8Array;
  },
  options: {
    readonly token: string;
    readonly sessionId?: string;
    readonly onHook: (hook: ClaudeHookInput) => Promise<ClaudeHookResponse>;
  },
): Promise<ClaudeHookDispatchResult> {
  if (request.method !== "POST") {
    return { status: 405, body: { error: "Method not allowed" } };
  }
  if (!authorized(request.authorization, options.token)) {
    return { status: 401, body: { error: "Unauthorized" } };
  }
  if (request.body.byteLength > MAX_HOOK_BODY_BYTES) {
    return { status: 413, body: { error: "Request body too large" } };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(request.body));
  } catch {
    return { status: 400, body: { error: "Invalid JSON" } };
  }
  if (
    !decoded ||
    typeof decoded !== "object" ||
    Array.isArray(decoded) ||
    typeof (decoded as Record<string, unknown>).hook_event_name !== "string"
  ) {
    return { status: 400, body: { error: "Invalid hook payload" } };
  }
  const hook = decoded as ClaudeHookInput;
  if (options.sessionId !== undefined && hook.session_id !== options.sessionId) {
    return { status: 403, body: { error: "Unknown Claude session" } };
  }
  return { status: 200, body: await options.onHook(hook) };
}

export interface ClaudeHookServer {
  readonly url: string;
  readonly close: () => Promise<void>;
}

export type ClaudeHookServerFactory = (input: {
  readonly token: string;
  readonly sessionId: string;
  readonly onHook: (hook: ClaudeHookInput) => Promise<ClaudeHookResponse>;
}) => Promise<ClaudeHookServer>;

export const startClaudeHookServer: ClaudeHookServerFactory = async ({
  token,
  sessionId,
  onHook,
}) => {
  const server = NodeHttp.createServer((request, response) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    request.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.byteLength;
      if (size > MAX_HOOK_BODY_BYTES) {
        rejected = true;
        response.writeHead(413, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Request body too large" }));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (rejected) return;
      void dispatchClaudeHookRequest(
        {
          method: request.method,
          authorization:
            typeof request.headers.authorization === "string"
              ? request.headers.authorization
              : undefined,
          body: Buffer.concat(chunks),
        },
        { token, sessionId, onHook },
      )
        .then((result) => {
          response.writeHead(result.status, { "content-type": "application/json" });
          response.end(JSON.stringify(result.body));
        })
        .catch(() => {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Hook processing failed" }));
        });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (cause: Error) => {
      server.off("listening", onListening);
      reject(cause);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Claude hook server did not expose a TCP address.");
  }
  return {
    url: `http://127.0.0.1:${address.port}/hooks`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((cause) => (cause ? reject(cause) : resolve()));
      });
    },
  };
};
