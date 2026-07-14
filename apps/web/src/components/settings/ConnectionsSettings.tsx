import { connectionStatusText } from "@t3tools/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  DesktopDiscoveredSshHost,
  DesktopSshEnvironmentTarget,
  EnvironmentId,
} from "@t3tools/contracts";
import { PlusIcon, RefreshCwIcon } from "lucide-react";
import * as Option from "effect/Option";
import { useCallback, useMemo, useState } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { connectSshEnvironment as connectSshEnvironmentAtom } from "~/connection/onboarding";
import { desktopSshHostsStateAtom } from "~/state/desktopSshHosts";
import { type EnvironmentPresentation, useEnvironments } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";

const EMPTY_DISCOVERED_SSH_HOSTS: ReadonlyArray<DesktopDiscoveredSshHost> = [];

function formatDesktopSshTarget(target: DesktopSshEnvironmentTarget): string {
  const authority = target.username ? `${target.username}@${target.hostname}` : target.hostname;
  return target.port ? `${authority}:${target.port}` : authority;
}

function parseManualDesktopSshTarget(input: {
  readonly host: string;
  readonly username: string;
  readonly port: string;
}): DesktopSshEnvironmentTarget {
  const rawHost = input.host.trim();
  if (rawHost.length === 0) {
    throw new Error("SSH host or alias is required.");
  }

  let hostname = rawHost;
  let username = input.username.trim() || null;
  let port: number | null = null;
  const atIndex = hostname.lastIndexOf("@");
  if (atIndex > 0) {
    const inlineUsername = hostname.slice(0, atIndex).trim();
    hostname = hostname.slice(atIndex + 1).trim();
    if (!username && inlineUsername.length > 0) {
      username = inlineUsername;
    }
  }

  const bracketedHostMatch = /^\[([^\]]+)\](?::(\d+))?$/u.exec(hostname);
  if (bracketedHostMatch) {
    hostname = bracketedHostMatch[1]!.trim();
    if (bracketedHostMatch[2]) {
      port = Number.parseInt(bracketedHostMatch[2], 10);
    }
  } else {
    const colonSegments = hostname.split(":");
    if (colonSegments.length === 2 && /^\d+$/u.test(colonSegments[1] ?? "")) {
      hostname = colonSegments[0]!.trim();
      port = Number.parseInt(colonSegments[1]!, 10);
    }
  }

  const rawPort = input.port.trim();
  if (rawPort.length > 0) {
    port = Number.parseInt(rawPort, 10);
  }
  if (hostname.length === 0) {
    throw new Error("SSH host or alias is required.");
  }
  if (port !== null && (!Number.isInteger(port) || port <= 0 || port > 65_535)) {
    throw new Error("SSH port must be between 1 and 65535.");
  }

  return { alias: hostname, hostname, username, port };
}

function formatDesktopSshConnectionError(error: unknown): string {
  const fallback = "Failed to connect SSH host.";
  const rawMessage = error instanceof Error ? error.message : fallback;
  return (
    rawMessage
      .replace(/^Error invoking remote method 'desktop:ensure-ssh-environment':\s*/u, "")
      .replace(/^Ssh[A-Za-z]+Error:\s*/u, "")
      .trim() || fallback
  );
}

function readSshTarget(environment: EnvironmentPresentation): DesktopSshEnvironmentTarget | null {
  const profile = environment.entry.profile;
  return environment.entry.target._tag === "SshConnectionTarget" &&
    Option.isSome(profile) &&
    profile.value._tag === "SshConnectionProfile"
    ? profile.value.target
    : null;
}

export function ConnectionsSettings() {
  const bridge = window.desktopBridge;
  const { environments } = useEnvironments();
  const connectSshEnvironment = useAtomCommand(connectSshEnvironmentAtom, {
    reportFailure: false,
  });
  const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const desktopSshHosts = useEnvironmentQuery(bridge ? desktopSshHostsStateAtom : null);
  const savedSshEnvironments = useMemo(
    () =>
      environments
        .filter((environment) => readSshTarget(environment) !== null)
        .toSorted((left, right) => left.label.localeCompare(right.label)),
    [environments],
  );
  const savedSshTargetKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const environment of savedSshEnvironments) {
      const target = readSshTarget(environment);
      if (target === null) continue;
      keys.add(target.alias);
      keys.add(formatDesktopSshTarget(target));
    }
    return keys;
  }, [savedSshEnvironments]);
  const discoveredSshHosts = desktopSshHosts.data ?? EMPTY_DISCOVERED_SSH_HOSTS;
  const unsavedDiscoveredSshHosts = useMemo(
    () =>
      discoveredSshHosts.filter(
        (target) =>
          !savedSshTargetKeys.has(target.alias) &&
          !savedSshTargetKeys.has(formatDesktopSshTarget(target)),
      ),
    [discoveredSshHosts, savedSshTargetKeys],
  );
  const [sshHost, setSshHost] = useState("");
  const [sshUsername, setSshUsername] = useState("");
  const [sshPort, setSshPort] = useState("");
  const [sshConnectionError, setSshConnectionError] = useState<string | null>(null);
  const [connectingSshHostAlias, setConnectingSshHostAlias] = useState<string | null>(null);
  const [removingSshEnvironmentId, setRemovingSshEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );

  const connectSshTarget = useCallback(
    async (target: DesktopSshEnvironmentTarget) => {
      setConnectingSshHostAlias(target.alias);
      setSshConnectionError(null);
      const result = await connectSshEnvironment({ target, label: "" });
      setConnectingSshHostAlias(null);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          setSshConnectionError(formatDesktopSshConnectionError(squashAtomCommandFailure(result)));
        }
        return;
      }
      setSshHost("");
      setSshUsername("");
      setSshPort("");
      toastManager.add({
        type: "success",
        title: "SSH environment connected",
        description: `${target.alias} is ready over a local SSH-managed tunnel.`,
      });
    },
    [connectSshEnvironment],
  );

  const connectManualSshTarget = useCallback(() => {
    let target: DesktopSshEnvironmentTarget;
    try {
      target = parseManualDesktopSshTarget({
        host: sshHost,
        username: sshUsername,
        port: sshPort,
      });
    } catch (error) {
      setSshConnectionError(formatDesktopSshConnectionError(error));
      return;
    }
    void connectSshTarget(target);
  }, [connectSshTarget, sshHost, sshPort, sshUsername]);

  const reconnectSshEnvironment = useCallback(
    async (environmentId: EnvironmentId) => {
      setSshConnectionError(null);
      const result = await retryEnvironment(environmentId);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        setSshConnectionError(formatDesktopSshConnectionError(squashAtomCommandFailure(result)));
      }
    },
    [retryEnvironment],
  );

  const removeSshEnvironment = useCallback(
    async (environmentId: EnvironmentId) => {
      setRemovingSshEnvironmentId(environmentId);
      setSshConnectionError(null);
      const result = await removeEnvironment(environmentId);
      setRemovingSshEnvironmentId(null);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        setSshConnectionError(formatDesktopSshConnectionError(squashAtomCommandFailure(result)));
      }
    },
    [removeEnvironment],
  );

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="SSH environments"
        headerAction={
          bridge ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={desktopSshHosts.isPending}
              onClick={desktopSshHosts.refresh}
            >
              <RefreshCwIcon
                className={desktopSshHosts.isPending ? "size-3 animate-spin" : "size-3"}
              />
              Refresh hosts
            </Button>
          ) : null
        }
      >
        {!bridge ? (
          <SettingsRow
            title="SSH environments"
            description="SSH-managed coding environments are available in the Ethereal desktop app."
          />
        ) : (
          <>
            <SettingsRow
              title="Add an SSH host"
              description="Ethereal uses your local SSH config and agent, starts `t3 serve` on the host, and keeps its API on a loopback tunnel."
              status={
                sshConnectionError || desktopSshHosts.error ? (
                  <span className="text-destructive">
                    {sshConnectionError ?? desktopSshHosts.error}
                  </span>
                ) : null
              }
            >
              <form
                className="mt-3 grid gap-3 border-t border-border/60 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.7fr)_6rem_auto] sm:items-end"
                onSubmit={(event) => {
                  event.preventDefault();
                  connectManualSshTarget();
                }}
              >
                <label className="space-y-1.5 text-xs font-medium text-foreground">
                  Host or alias
                  <Input
                    value={sshHost}
                    onChange={(event) => setSshHost(event.target.value)}
                    placeholder="devbox"
                    disabled={connectingSshHostAlias !== null}
                    spellCheck={false}
                  />
                </label>
                <label className="space-y-1.5 text-xs font-medium text-foreground">
                  Username
                  <Input
                    value={sshUsername}
                    onChange={(event) => setSshUsername(event.target.value)}
                    placeholder="Optional"
                    disabled={connectingSshHostAlias !== null}
                    spellCheck={false}
                  />
                </label>
                <label className="space-y-1.5 text-xs font-medium text-foreground">
                  Port
                  <Input
                    value={sshPort}
                    onChange={(event) => setSshPort(event.target.value)}
                    placeholder="22"
                    inputMode="numeric"
                    disabled={connectingSshHostAlias !== null}
                    spellCheck={false}
                  />
                </label>
                <Button type="submit" size="sm" disabled={connectingSshHostAlias !== null}>
                  <PlusIcon className="size-3.5" />
                  {connectingSshHostAlias !== null ? "Connecting…" : "Add"}
                </Button>
              </form>
            </SettingsRow>

            {savedSshEnvironments.map((environment) => {
              const target = readSshTarget(environment);
              if (target === null) return null;
              const isConnecting =
                environment.connection.phase === "connecting" ||
                environment.connection.phase === "reconnecting";
              const isRemoving = removingSshEnvironmentId === environment.environmentId;
              return (
                <SettingsRow
                  key={environment.environmentId}
                  title={environment.label}
                  description={`SSH ${formatDesktopSshTarget(target)}`}
                  status={connectionStatusText(environment.connection)}
                  control={
                    <>
                      {environment.connection.phase !== "connected" ? (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={isConnecting || isRemoving}
                          onClick={() => void reconnectSshEnvironment(environment.environmentId)}
                        >
                          {isConnecting ? "Connecting…" : "Reconnect"}
                        </Button>
                      ) : null}
                      <Button
                        size="xs"
                        variant="destructive-outline"
                        disabled={isConnecting || isRemoving}
                        onClick={() => void removeSshEnvironment(environment.environmentId)}
                      >
                        {isRemoving ? "Removing…" : "Remove"}
                      </Button>
                    </>
                  }
                />
              );
            })}

            {unsavedDiscoveredSshHosts.map((target) => (
              <SettingsRow
                key={`${target.alias}:${target.hostname}:${target.port ?? ""}`}
                title={target.alias}
                description={`${formatDesktopSshTarget(target)} · Discovered from ${target.source === "ssh-config" ? "SSH config" : "known hosts"}`}
                control={
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={connectingSshHostAlias !== null}
                    onClick={() => void connectSshTarget(target)}
                  >
                    {connectingSshHostAlias === target.alias ? "Connecting…" : "Add"}
                  </Button>
                }
              />
            ))}

            {!desktopSshHosts.isPending &&
            desktopSshHosts.data !== null &&
            savedSshEnvironments.length === 0 &&
            unsavedDiscoveredSshHosts.length === 0 ? (
              <SettingsRow
                title="No SSH hosts found"
                description="Add a host manually or add aliases to ~/.ssh/config, then refresh."
              />
            ) : null}
          </>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
