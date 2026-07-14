import {
  ClientPresentation,
  EnvironmentOwnedDataCleanup,
  PlatformConnectionSource,
  PrimaryEnvironmentAuth,
  SshEnvironmentGateway,
} from "@t3tools/client-runtime/platform";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  Connectivity,
  mapRemoteEnvironmentError,
  type PlatformConnectionRegistration,
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
  Wakeups,
} from "@t3tools/client-runtime/connection";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import { EnvironmentRpcRequestObserver } from "@t3tools/client-runtime/rpc";
import {
  AuthStandardClientScopes,
  type DesktopBridge,
  type DesktopSshEnvironmentTarget,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { primaryEnvironmentHttpLayer } from "../environments/primary/httpLayer";
import {
  readPrimaryEnvironmentTarget,
  type PrimaryEnvironmentTarget,
} from "../environments/primary/target";
import { clearComposerDraftsEnvironment } from "../composerDraftStore";
import { acknowledgeRpcRequest, trackRpcRequestSent } from "../rpc/requestLatencyState";
import { connectionStorageLayer } from "./storage";

let nextObservedRpcRequestId = 0;

function currentNetworkStatus(): "unknown" | "offline" | "online" {
  if (typeof navigator === "undefined") {
    return "unknown";
  }
  return navigator.onLine ? "online" : "offline";
}

const connectivityLayer = Connectivity.layer({
  status: Effect.sync(currentNetworkStatus),
  changes: Stream.callback((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const online = () => Queue.offerUnsafe(queue, "online");
        const offline = () => Queue.offerUnsafe(queue, "offline");
        window.addEventListener("online", online);
        window.addEventListener("offline", offline);
        return { online, offline };
      }),
      ({ online, offline }) =>
        Effect.sync(() => {
          window.removeEventListener("online", online);
          window.removeEventListener("offline", offline);
        }),
    ).pipe(Effect.asVoid),
  ),
});

const wakeupsLayer = Wakeups.layer({
  changes: Stream.callback<"application-active">((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const listener = () => {
          if (document.visibilityState === "visible") {
            Queue.offerUnsafe(queue, "application-active");
          }
        };
        document.addEventListener("visibilitychange", listener);
        return listener;
      }),
      (listener) =>
        Effect.sync(() => {
          document.removeEventListener("visibilitychange", listener);
        }),
    ).pipe(Effect.asVoid),
  ),
});

function clientMetadata() {
  const desktop = window.desktopBridge !== undefined;
  const platform = navigator.platform.trim();
  return {
    label: desktop ? "Ethereal Desktop" : "Ethereal Renderer",
    deviceType: "desktop" as const,
    ...(platform === "" ? {} : { os: platform }),
  };
}

function sshPreparationError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.toLowerCase().includes("cancel")) {
    return new ConnectionBlockedError({
      reason: "authentication",
      detail: message,
    });
  }
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: `Could not prepare the SSH environment: ${message}`,
  });
}

export const provisionDesktopSshEnvironment = Effect.fn(
  "web.connectionPlatform.ssh.provisionDesktop",
)(function* (bridge: DesktopBridge, target: DesktopSshEnvironmentTarget) {
  const bootstrap = yield* Effect.tryPromise({
    try: () =>
      bridge.ensureSshEnvironment(target, {
        issuePairingToken: true,
      }),
    catch: sshPreparationError,
  });
  const pairingToken = bootstrap.pairingToken;
  if (pairingToken === null) {
    return yield* new ConnectionBlockedError({
      reason: "authentication",
      detail: "The SSH environment did not issue a pairing credential.",
    });
  }
  const descriptor = yield* Effect.tryPromise({
    try: () => bridge.fetchSshEnvironmentDescriptor(bootstrap.httpBaseUrl),
    catch: sshPreparationError,
  });
  const access = yield* Effect.tryPromise({
    try: () => bridge.bootstrapSshBearerSession(bootstrap.httpBaseUrl, pairingToken),
    catch: sshPreparationError,
  });
  return {
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    bootstrap,
    bearerToken: access.access_token,
  };
});

const capabilitiesLayer = Layer.effectContext(
  Effect.sync(() => {
    const presentation = ClientPresentation.of({
      metadata: clientMetadata(),
      scopes: AuthStandardClientScopes,
    });
    const primaryAuth = PrimaryEnvironmentAuth.of({
      bearerToken: Effect.tryPromise({
        try: readDesktopPrimaryBearerToken,
        catch: (cause) =>
          new ConnectionTransientError({
            reason: "remote-unavailable",
            detail: `Could not load the desktop primary credential: ${String(cause)}`,
          }),
      }).pipe(Effect.map(Option.fromNullishOr)),
    });
    const ssh = SshEnvironmentGateway.of({
      provision: Effect.fn("web.connectionPlatform.ssh.provision")(function* (target) {
        const bridge = window.desktopBridge;
        if (bridge === undefined) {
          return yield* new ConnectionBlockedError({
            reason: "unsupported",
            detail: "SSH environments are only available in the desktop app.",
          });
        }
        return yield* provisionDesktopSshEnvironment(bridge, target);
      }),
      prepare: Effect.fn("web.connectionPlatform.ssh.prepare")(function* (input) {
        const bridge = window.desktopBridge;
        if (bridge === undefined) {
          return yield* new ConnectionBlockedError({
            reason: "unsupported",
            detail: "SSH environments are only available in the desktop app.",
          });
        }
        const bootstrap = yield* Effect.tryPromise({
          try: () =>
            bridge.ensureSshEnvironment(input.target, {
              issuePairingToken: true,
            }),
          catch: sshPreparationError,
        });
        if (bootstrap.pairingToken === null) {
          return yield* new ConnectionBlockedError({
            reason: "authentication",
            detail: "The SSH environment did not issue a pairing credential.",
          });
        }
        const access = yield* Effect.tryPromise({
          try: () =>
            bridge.bootstrapSshBearerSession(bootstrap.httpBaseUrl, bootstrap.pairingToken!),
          catch: sshPreparationError,
        });
        return {
          bootstrap,
          bearerToken: access.access_token,
        };
      }),
      disconnect: Effect.fn("web.connectionPlatform.ssh.disconnect")(function* (target) {
        const bridge = window.desktopBridge;
        if (bridge === undefined) {
          return;
        }
        yield* Effect.tryPromise({
          try: () => bridge.disconnectSshEnvironment(target),
          catch: (cause) =>
            new ConnectionTransientError({
              reason: "remote-unavailable",
              detail: `Could not disconnect the SSH environment: ${String(cause)}`,
            }),
        });
      }),
    });
    return Context.make(PrimaryEnvironmentAuth, primaryAuth).pipe(
      Context.add(ClientPresentation, presentation),
      Context.add(SshEnvironmentGateway, ssh),
    );
  }),
);

const loadPrimaryConnectionRegistration = Effect.fn(
  "web.connectionPlatform.loadPrimaryConnectionRegistration",
)(function* (resolved: PrimaryEnvironmentTarget) {
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: resolved.target.httpBaseUrl,
  }).pipe(Effect.provide(primaryEnvironmentHttpLayer), Effect.mapError(mapRemoteEnvironmentError));
  return new PrimaryConnectionRegistration({
    target: new PrimaryConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: resolved.target.httpBaseUrl,
      wsBaseUrl: resolved.target.wsBaseUrl,
    }),
  });
});

const PLATFORM_POLL_INTERVAL = "3 seconds";

interface CachedPlatformRegistration {
  readonly signature: string;
  readonly registration: PlatformConnectionRegistration;
}

export type PrimaryEnvironmentTargetRead =
  | {
      readonly _tag: "Success";
      readonly target: PrimaryEnvironmentTarget | null;
    }
  | {
      readonly _tag: "Failure";
      readonly cause: unknown;
    };

export function readPrimaryEnvironmentTargetResult(
  readTarget: () => PrimaryEnvironmentTarget | null = readPrimaryEnvironmentTarget,
): PrimaryEnvironmentTargetRead {
  try {
    return { _tag: "Success", target: readTarget() };
  } catch (cause) {
    return { _tag: "Failure", cause };
  }
}

export function primaryRegistrationToRetainAfterTopologyRead(
  previous: ReadonlyMap<string, CachedPlatformRegistration>,
  topologyRead: PrimaryEnvironmentTargetRead,
): CachedPlatformRegistration | undefined {
  return topologyRead._tag === "Failure" ? previous.get(PRIMARY_LOCAL_ENVIRONMENT_ID) : undefined;
}

export function canReuseCachedPlatformRegistration(
  cached: CachedPlatformRegistration,
  signature: string,
): boolean {
  return cached.signature === signature;
}

const platformConnectionSourceLayer = Layer.effect(
  PlatformConnectionSource,
  Effect.gen(function* () {
    const cacheRef = yield* Ref.make(new Map<string, CachedPlatformRegistration>());

    // Resolve the platform-managed local environment. Reused registrations
    // come from the cache; a failed read is retried on the next poll.
    const buildPlatformRegistrations = Effect.gen(function* () {
      const previous = yield* Ref.get(cacheRef);
      const next = new Map<string, CachedPlatformRegistration>();
      const registrations: Array<PlatformConnectionRegistration> = [];

      const primaryTopologyRead = readPrimaryEnvironmentTargetResult();
      const retainedPrimary = primaryRegistrationToRetainAfterTopologyRead(
        previous,
        primaryTopologyRead,
      );
      if (retainedPrimary !== undefined) {
        next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, retainedPrimary);
        registrations.push(retainedPrimary.registration);
      }

      if (primaryTopologyRead._tag === "Failure") {
        yield* Effect.logWarning("Could not read the primary environment topology.", {
          cause: primaryTopologyRead.cause,
        });
      } else if (primaryTopologyRead.target !== null) {
        const primaryTarget = primaryTopologyRead.target;
        const signature = `primary|${primaryTarget.target.httpBaseUrl}|${primaryTarget.target.wsBaseUrl}`;
        const cached = previous.get(PRIMARY_LOCAL_ENVIRONMENT_ID);
        if (cached !== undefined && canReuseCachedPlatformRegistration(cached, signature)) {
          next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, cached);
          registrations.push(cached.registration);
        } else {
          const built = yield* loadPrimaryConnectionRegistration(primaryTarget).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Could not discover the primary environment.", { error }),
            ),
            Effect.option,
          );
          if (Option.isSome(built)) {
            const cacheEntry = { signature, registration: built.value };
            next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, cacheEntry);
            registrations.push(built.value);
          }
        }
      }

      yield* Ref.set(cacheRef, next);
      return registrations as ReadonlyArray<PlatformConnectionRegistration>;
    });

    return PlatformConnectionSource.of({
      registrations: Stream.tick(PLATFORM_POLL_INTERVAL).pipe(
        Stream.mapEffect(() => buildPlatformRegistrations),
      ),
    });
  }),
);

const environmentOwnedDataCleanupLayer = Layer.succeed(
  EnvironmentOwnedDataCleanup,
  EnvironmentOwnedDataCleanup.of({
    clear: (environmentId) =>
      Effect.sync(() => {
        clearComposerDraftsEnvironment(environmentId);
      }),
  }),
);

const rpcRequestObserverLayer = Layer.succeed(
  EnvironmentRpcRequestObserver,
  EnvironmentRpcRequestObserver.of({
    observe: ({ environmentId, method }) =>
      Effect.sync(() => {
        nextObservedRpcRequestId += 1;
        const requestId = `${environmentId}:${nextObservedRpcRequestId}`;
        trackRpcRequestSent(requestId, `${method} · ${environmentId}`);
        return Effect.sync(() => {
          acknowledgeRpcRequest(requestId);
        });
      }),
  }),
);

type ConnectionPlatformLayerSource =
  | typeof connectionStorageLayer
  | typeof connectivityLayer
  | typeof wakeupsLayer
  | typeof capabilitiesLayer
  | typeof platformConnectionSourceLayer
  | typeof environmentOwnedDataCleanupLayer
  | typeof rpcRequestObserverLayer;

export const connectionPlatformLayer: Layer.Layer<
  Layer.Success<ConnectionPlatformLayerSource>,
  Layer.Error<ConnectionPlatformLayerSource>,
  Layer.Services<ConnectionPlatformLayerSource>
> = Layer.mergeAll(
  connectionStorageLayer,
  connectivityLayer,
  wakeupsLayer,
  capabilitiesLayer,
  platformConnectionSourceLayer,
  environmentOwnedDataCleanupLayer,
  rpcRequestObserverLayer,
);
