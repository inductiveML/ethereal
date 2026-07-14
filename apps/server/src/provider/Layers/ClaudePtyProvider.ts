import type { ClaudeSettings } from "@t3tools/contracts";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { checkClaudeProviderStatus, runClaudeCommand } from "./ClaudeProvider.ts";
import {
  makeClaudeSubscriptionSafeEnvironment,
  parseClaudePtyCapabilities,
} from "./ClaudePtyProtocol.ts";

interface ClaudeAuthStatus {
  readonly loggedIn: boolean;
  readonly authMethod?: string;
  readonly email?: string;
  readonly subscriptionType?: string;
}

function parseAuthStatus(output: string): ClaudeAuthStatus | null {
  try {
    const decoded: unknown = JSON.parse(output);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    const record = decoded as Record<string, unknown>;
    if (typeof record.loggedIn !== "boolean") return null;
    return {
      loggedIn: record.loggedIn,
      ...(typeof record.authMethod === "string" ? { authMethod: record.authMethod } : {}),
      ...(typeof record.email === "string" ? { email: record.email } : {}),
      ...(typeof record.subscriptionType === "string"
        ? { subscriptionType: record.subscriptionType }
        : {}),
    };
  } catch {
    return null;
  }
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/g)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function applyClaudePtyProbe(
  base: ServerProviderDraft,
  probe: {
    readonly versionOutput: string;
    readonly helpOutput: string;
    readonly authOutput: string;
  },
): ServerProviderDraft {
  const capabilities = parseClaudePtyCapabilities(probe);
  const auth = parseAuthStatus(probe.authOutput);
  const subscriptionAuthenticated =
    auth?.loggedIn === true &&
    (auth.subscriptionType !== undefined || auth.authMethod?.toLowerCase() === "claude.ai");
  const subscriptionType = auth?.subscriptionType;
  const capabilityReady =
    capabilities.interactive &&
    capabilities.sessionResume &&
    capabilities.modelSelection &&
    capabilities.sessionName &&
    capabilities.permissionModes &&
    capabilities.settingsInjection &&
    capabilities.httpHooks &&
    capabilities.permissionRequestHook;

  return {
    ...base,
    displayName: "Claude",
    badgeLabel: "Subscription",
    version: capabilities.version ?? base.version,
    status: !capabilityReady ? "error" : subscriptionAuthenticated ? "ready" : "warning",
    auth: auth?.loggedIn
      ? {
          status: "authenticated",
          ...(subscriptionType
            ? {
                type: subscriptionType,
                label: `Claude ${titleCase(subscriptionType)} Subscription`,
              }
            : {}),
          ...(auth.email ? { email: auth.email } : {}),
        }
      : { status: auth ? "unauthenticated" : "unknown" },
    ...(!capabilityReady
      ? {
          message:
            "Installed Claude Code does not expose the interactive session, resume, settings, and HTTP PermissionRequest hooks required by Ethereal.",
        }
      : !subscriptionAuthenticated
        ? {
            message:
              "Claude Code is installed, but subscription authentication was not detected. Run `claude auth login` in a terminal.",
          }
        : { message: undefined }),
  };
}

function collectedOutput(
  result: Result.Result<Option.Option<{ stdout: string; stderr: string; code: number }>, unknown>,
  requireSuccessfulExit = true,
): string | undefined {
  if (Result.isFailure(result) || Option.isNone(result.success)) return undefined;
  const command = result.success.value;
  if (requireSuccessfulExit && command.code !== 0) return undefined;
  return `${command.stdout}\n${command.stderr}`.trim();
}

export const checkClaudePtyProviderStatus = Effect.fn("checkClaudePtyProviderStatus")(function* (
  settings: ClaudeSettings,
  environment?: NodeJS.ProcessEnv,
  subscriptionOnly = true,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Path.Path
> {
  const probeEnvironment = subscriptionOnly
    ? makeClaudeSubscriptionSafeEnvironment(environment ?? process.env)
    : environment;
  const base = yield* checkClaudeProviderStatus(settings, probeEnvironment);
  if (!settings.enabled || !base.installed) {
    return { ...base, displayName: "Claude", badgeLabel: "Subscription" };
  }
  const run = (args: readonly string[], timeout: Duration.Input) =>
    runClaudeCommand(settings, args, probeEnvironment).pipe(
      Effect.timeoutOption(timeout),
      Effect.result,
    );
  const probes = yield* Effect.all(
    {
      version: run(["--version"], "4 seconds"),
      help: run(["--help"], "4 seconds"),
      auth: run(["auth", "status"], "10 seconds"),
    },
    { concurrency: "unbounded" },
  );
  const versionOutput = collectedOutput(probes.version);
  const helpOutput = collectedOutput(probes.help);
  // `claude auth status` returns useful JSON with a non-zero exit when logged
  // out. Parsing that is materially better than collapsing it into a probe
  // failure, and remains non-generative.
  const authOutput = collectedOutput(probes.auth, false);
  if (!versionOutput || !helpOutput || !authOutput) {
    return {
      ...base,
      displayName: "Claude",
      badgeLabel: "Subscription",
      status: "error",
      message: "Claude PTY capability or subscription-authentication probe failed.",
    };
  }
  return applyClaudePtyProbe(base, { versionOutput, helpOutput, authOutput });
});
