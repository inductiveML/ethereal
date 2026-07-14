import type { CanonicalItemType, ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";

// prompt_id correlation landed in 2.1.196 and the interactive `manual`
// permission mode in 2.1.200. Ethereal requires both so resume-time Stop hooks
// cannot complete a newly submitted turn and supervised sessions stay valid.
const HTTP_HOOK_MIN_VERSION = [2, 1, 200] as const;
const RESERVED_LAUNCH_FLAGS = new Set([
  "ax-screen-reader",
  "dangerously-skip-permissions",
  "effort",
  "input-format",
  "model",
  "output-format",
  "permission-mode",
  "print",
  "resume",
  "session-id",
  "settings",
]);

export interface ClaudePtyCapabilities {
  readonly version: string | null;
  readonly interactive: boolean;
  readonly sessionResume: boolean;
  readonly modelSelection: boolean;
  readonly sessionName: boolean;
  readonly permissionModes: boolean;
  readonly settingsInjection: boolean;
  readonly httpHooks: boolean;
  readonly permissionRequestHook: boolean;
  readonly effort: boolean;
}

function parseVersion(value: string): readonly number[] | null {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function versionAtLeast(actual: readonly number[] | null, expected: readonly number[]): boolean {
  if (!actual) return false;
  for (let index = 0; index < expected.length; index++) {
    const left = actual[index] ?? 0;
    const right = expected[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

export function parseClaudePtyCapabilities(input: {
  readonly versionOutput: string;
  readonly helpOutput: string;
}): ClaudePtyCapabilities {
  const parsedVersion = parseVersion(input.versionOutput);
  const version = parsedVersion ? parsedVersion.join(".") : null;
  const has = (flag: string) => input.helpOutput.includes(flag);
  const settingsInjection = has("--settings");
  const httpHooks = settingsInjection && versionAtLeast(parsedVersion, HTTP_HOOK_MIN_VERSION);
  return {
    version,
    interactive: !has("interactive mode unavailable"),
    sessionResume: has("--session-id") && has("--resume"),
    modelSelection: has("--model"),
    sessionName: has("--name"),
    permissionModes: has("--permission-mode"),
    settingsInjection,
    httpHooks,
    permissionRequestHook: httpHooks && has("--permission-mode"),
    effort: has("--effort"),
  };
}

function tokenizeLaunchArgs(source: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const character of source.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("Claude launch arguments contain an unterminated quote.");
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function validateExtraLaunchArgs(tokens: readonly string[]): void {
  for (const token of tokens) {
    if (!token.startsWith("--")) continue;
    const flag = token.slice(2).split("=", 1)[0] ?? "";
    if (RESERVED_LAUNCH_FLAGS.has(flag)) {
      throw new Error(`Claude launch arguments use reserved flag --${flag}.`);
    }
  }
}

function permissionArgs(
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
): string[] {
  if (interactionMode === "plan") return ["--permission-mode", "plan"];
  switch (runtimeMode) {
    case "approval-required":
      return ["--permission-mode", "manual"];
    case "auto-accept-edits":
      return ["--permission-mode", "acceptEdits"];
    case "full-access":
      return ["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"];
  }
}

const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Stop",
  "SessionEnd",
] as const;

function makeHookSettings(url: string, tokenEnvironmentVariable: string): string {
  const hook = {
    type: "http",
    url,
    headers: {
      Authorization: `Bearer $${tokenEnvironmentVariable}`,
    },
    allowedEnvVars: [tokenEnvironmentVariable],
  };
  return JSON.stringify({
    hooks: Object.fromEntries(HOOK_EVENTS.map((event) => [event, [{ hooks: [hook] }]])),
  });
}

export interface ClaudePtyLaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

export function makeClaudeSubscriptionSafeEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment = { ...baseEnvironment };
  delete environment.ANTHROPIC_API_KEY;
  delete environment.ANTHROPIC_AUTH_TOKEN;
  delete environment.ANTHROPIC_BASE_URL;
  delete environment.CLAUDE_CODE_USE_BEDROCK;
  delete environment.CLAUDE_CODE_USE_VERTEX;
  delete environment.CLAUDE_CODE_USE_FOUNDRY;
  return environment;
}

export function buildClaudePtyLaunchSpec(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly homePath: string;
  readonly sessionId: string;
  readonly resumeSessionId?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly hookUrl: string;
  readonly hookTokenEnvironmentVariable: string;
  readonly hookToken?: string;
  readonly baseEnvironment: NodeJS.ProcessEnv;
  readonly launchArgs: string;
  readonly subscriptionOnly?: boolean;
}): ClaudePtyLaunchSpec {
  const extraArgs = tokenizeLaunchArgs(input.launchArgs);
  validateExtraLaunchArgs(extraArgs);
  let environment: NodeJS.ProcessEnv = {
    ...input.baseEnvironment,
    HOME: input.homePath,
    TERM: input.baseEnvironment.TERM ?? "xterm-256color",
    COLORTERM: input.baseEnvironment.COLORTERM ?? "truecolor",
    CLAUDE_CODE_ENTRYPOINT: "ethereal",
    ...(input.hookToken ? { [input.hookTokenEnvironmentVariable]: input.hookToken } : {}),
  };
  // The built-in Claude instance is subscription-authenticated. Explicit API
  // credentials must not silently redirect it onto usage-based billing.
  if (input.subscriptionOnly !== false) {
    environment = makeClaudeSubscriptionSafeEnvironment(environment);
  }

  const args = [
    input.resumeSessionId ? "--resume" : "--session-id",
    input.resumeSessionId ?? input.sessionId,
    "--name",
    "Ethereal",
    "--ax-screen-reader",
    ...permissionArgs(input.runtimeMode, input.interactionMode ?? "default"),
    ...(input.model ? ["--model", input.model] : []),
    ...(input.effort ? ["--effort", input.effort] : []),
    "--settings",
    makeHookSettings(input.hookUrl, input.hookTokenEnvironmentVariable),
    ...extraArgs,
  ];

  return { command: input.binaryPath, args, cwd: input.cwd, environment };
}

export function encodeClaudeBracketedPaste(input: string): string {
  const withoutEscapes = input.replace(/\r\n?/g, "\n").replaceAll(String.fromCharCode(27), "");
  const normalized = [...withoutEscapes]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (code >= 0 && code <= 8) ||
        code === 11 ||
        code === 12 ||
        (code >= 14 && code <= 31) ||
        code === 127
        ? "\uFFFD"
        : character;
    })
    .join("");
  return `\u001b[200~${normalized}\u001b[201~`;
}

export type ClaudePtyReadinessState =
  | "starting"
  | "needs-attention"
  | "ready"
  | "working"
  | "waiting-for-permission"
  | "interrupted"
  | "failed"
  | "closed";

export interface ClaudePtyReadiness {
  readonly state: ClaudePtyReadinessState;
  readonly lastOutput: string;
  readonly reason?: string;
}

export const initialClaudePtyReadiness: ClaudePtyReadiness = {
  state: "starting",
  lastOutput: "",
};

export type ClaudePtyReadinessSignal =
  | { readonly type: "spawned" }
  | { readonly type: "pty-output"; readonly data: string }
  | { readonly type: "hook"; readonly event: "SessionStart" | "Stop" | "SessionEnd" }
  | { readonly type: "prompt-submitted" }
  | { readonly type: "turn-completed" }
  | { readonly type: "permission-requested" }
  | { readonly type: "permission-resolved" }
  | { readonly type: "interrupt-requested" }
  | { readonly type: "attention"; readonly reason: string }
  | { readonly type: "process-exit"; readonly reason: string }
  | { readonly type: "failed"; readonly reason: string };

function ptyOutputNeedsAttention(value: string): boolean {
  const ansiSequence = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
  const plain = value.replace(ansiSequence, "").toLowerCase();
  return [
    "not logged in",
    "select login method",
    "do you trust",
    "trust this folder",
    "update required",
    "press enter to continue",
  ].some((marker) => plain.includes(marker));
}

function ptyOutputIsReady(value: string): boolean {
  const ansiSequence = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
  const plain = value.replace(ansiSequence, "").replaceAll("\r\n", "\n");
  return plain.includes("\n Ethereal\n$");
}

export function advanceClaudePtyReadiness(
  current: ClaudePtyReadiness,
  signal: ClaudePtyReadinessSignal,
): ClaudePtyReadiness {
  switch (signal.type) {
    case "spawned":
      return { ...current, state: "starting" };
    case "pty-output": {
      const lastOutput = (current.lastOutput + signal.data).slice(-8_192);
      const needsAttention = current.state === "starting" && ptyOutputNeedsAttention(lastOutput);
      const canDiscoverIdlePrompt = current.state === "starting" || current.state === "interrupted";
      if (needsAttention) {
        return {
          ...current,
          lastOutput,
          state: "needs-attention",
          reason: "Claude requires terminal attention.",
        };
      }
      if (canDiscoverIdlePrompt && ptyOutputIsReady(lastOutput)) {
        const { reason: _reason, ...withoutReason } = current;
        return { ...withoutReason, lastOutput, state: "ready" };
      }
      return { ...current, lastOutput };
    }
    case "hook":
      if (signal.event === "SessionStart") return { ...current, state: "ready" };
      if (signal.event === "Stop") {
        return { ...current, state: current.state === "interrupted" ? "interrupted" : "ready" };
      }
      return { ...current, state: "closed" };
    case "prompt-submitted":
      return { ...current, state: "working" };
    case "turn-completed":
      return { ...current, state: "ready" };
    case "permission-requested":
      return { ...current, state: "waiting-for-permission" };
    case "permission-resolved":
      return { ...current, state: "working" };
    case "interrupt-requested":
      return { ...current, state: "interrupted", lastOutput: "" };
    case "attention":
      return { ...current, state: "needs-attention", reason: signal.reason };
    case "process-exit":
      return { ...current, state: "closed", reason: signal.reason };
    case "failed":
      return { ...current, state: "failed", reason: signal.reason };
  }
}

export interface ClaudeTranscriptCursor {
  readonly offset: number;
  readonly pending: Uint8Array;
  readonly fileId?: string;
}

export const initialClaudeTranscriptCursor: ClaudeTranscriptCursor = {
  offset: 0,
  pending: new Uint8Array(),
};

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right.slice();
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

export function consumeClaudeTranscriptBytes(
  cursor: ClaudeTranscriptCursor,
  bytes: Uint8Array,
): {
  readonly cursor: ClaudeTranscriptCursor;
  readonly records: readonly Record<string, unknown>[];
  readonly invalidLines: readonly string[];
} {
  const combined = concatBytes(cursor.pending, bytes);
  const records: Record<string, unknown>[] = [];
  const invalidLines: string[] = [];
  let lineStart = 0;
  for (let index = 0; index < combined.byteLength; index++) {
    if (combined[index] !== 10) continue;
    const line = new TextDecoder().decode(combined.subarray(lineStart, index)).trim();
    lineStart = index + 1;
    if (line.length === 0) continue;
    try {
      const decoded: unknown = JSON.parse(line);
      if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
        records.push(decoded as Record<string, unknown>);
      } else {
        invalidLines.push(line);
      }
    } catch {
      invalidLines.push(line);
    }
  }
  let pending = combined.slice(lineStart);
  if (pending.byteLength > 4 * 1024 * 1024) {
    invalidLines.push("[oversized Claude JSONL record discarded]");
    pending = new Uint8Array();
  }
  return {
    cursor: {
      offset: cursor.offset + bytes.byteLength,
      pending,
      ...(cursor.fileId ? { fileId: cursor.fileId } : {}),
    },
    records,
    invalidLines,
  };
}

export type ClaudeTranscriptSemanticEvent =
  | {
      readonly type: "assistant-text";
      readonly messageId: string;
      readonly blockIndex: number;
      readonly text: string;
    }
  | {
      readonly type: "tool-started";
      readonly toolUseId: string;
      readonly toolName: string;
      readonly itemType: CanonicalItemType;
      readonly input: Record<string, unknown>;
    }
  | {
      readonly type: "tool-completed";
      readonly toolUseId: string;
      readonly content: string;
      readonly failed: boolean;
    }
  | { readonly type: "user-acknowledged"; readonly messageId: string; readonly text: string }
  | { readonly type: "assistant-stop"; readonly messageId: string; readonly reason: string }
  | { readonly type: "usage"; readonly inputTokens: number; readonly outputTokens: number };

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toolItemType(name: string): CanonicalItemType {
  const normalized = name.toLowerCase();
  if (normalized.includes("agent") || normalized.includes("subagent")) {
    return "collab_agent_tool_call";
  }
  if (["bash", "command", "shell", "terminal"].some((part) => normalized.includes(part))) {
    return "command_execution";
  }
  if (
    ["edit", "write", "patch", "replace", "notebookedit"].some((part) => normalized.includes(part))
  ) {
    return "file_change";
  }
  if (normalized.includes("websearch") || normalized.includes("webfetch")) return "web_search";
  if (normalized.startsWith("mcp__") || normalized.includes("mcp")) return "mcp_tool_call";
  if (normalized.includes("image")) return "image_view";
  return "dynamic_tool_call";
}

function toolResultContent(value: unknown): string {
  let result: string;
  if (typeof value === "string") result = value;
  else if (Array.isArray(value)) {
    result = value
      .map((entry) => {
        const object = objectValue(entry);
        return object && typeof object.text === "string" ? object.text : JSON.stringify(entry);
      })
      .join("\n");
  } else {
    result = value === undefined ? "" : JSON.stringify(value);
  }
  return result.length <= 8_192 ? result : `${result.slice(0, 8_189)}...`;
}

export function parseClaudeTranscriptRecord(
  record: Record<string, unknown>,
): readonly ClaudeTranscriptSemanticEvent[] {
  const message = objectValue(record.message);
  const content = message && Array.isArray(message.content) ? message.content : [];
  const events: ClaudeTranscriptSemanticEvent[] = [];
  if (record.type === "assistant" && message) {
    const messageId = typeof record.uuid === "string" ? record.uuid : "assistant";
    content.forEach((rawBlock, blockIndex) => {
      const block = objectValue(rawBlock);
      if (!block) return;
      if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
        events.push({ type: "assistant-text", messageId, blockIndex, text: block.text });
      }
      if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        events.push({
          type: "tool-started",
          toolUseId: block.id,
          toolName: block.name,
          itemType: toolItemType(block.name),
          input: objectValue(block.input) ?? {},
        });
      }
    });
    const usage = objectValue(message.usage);
    if (usage) {
      const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
      const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
      events.push({ type: "usage", inputTokens, outputTokens });
    }
    if (typeof message.stop_reason === "string") {
      events.push({ type: "assistant-stop", messageId, reason: message.stop_reason });
    }
  }
  if (record.type === "user") {
    const messageId = typeof record.uuid === "string" ? record.uuid : "user";
    if (typeof message?.content === "string") {
      events.push({ type: "user-acknowledged", messageId, text: message.content });
    }
    for (const rawBlock of content) {
      const block = objectValue(rawBlock);
      if (block?.type === "text" && typeof block.text === "string") {
        events.push({ type: "user-acknowledged", messageId, text: block.text });
      }
      if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      events.push({
        type: "tool-completed",
        toolUseId: block.tool_use_id,
        content: toolResultContent(block.content),
        failed: block.is_error === true,
      });
    }
  }
  return events;
}

/** Offset that is safe to persist without serializing an incomplete JSONL line. */
export function durableClaudeTranscriptOffset(cursor: ClaudeTranscriptCursor): number {
  return Math.max(0, cursor.offset - cursor.pending.byteLength);
}
