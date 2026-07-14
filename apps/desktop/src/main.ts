import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

import * as NetService from "@t3tools/shared/Net";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveRemoteT3CliPackageSpec } from "@t3tools/ssh/command";
import type { RemoteT3RunnerOptions } from "@t3tools/ssh/tunnel";
import serverPackageJson from "../../server/package.json" with { type: "json" };

import * as DesktopIpc from "./ipc/DesktopIpc.ts";
import * as ElectronApp from "./electron/ElectronApp.ts";
import * as ElectronDialog from "./electron/ElectronDialog.ts";
import * as ElectronMenu from "./electron/ElectronMenu.ts";
import * as ElectronProtocol from "./electron/ElectronProtocol.ts";
import * as ElectronSafeStorage from "./electron/ElectronSafeStorage.ts";
import * as ElectronShell from "./electron/ElectronShell.ts";
import * as ElectronTheme from "./electron/ElectronTheme.ts";
import * as ElectronWindow from "./electron/ElectronWindow.ts";
import * as DesktopApp from "./app/DesktopApp.ts";
import * as DesktopAppIdentity from "./app/DesktopAppIdentity.ts";
import * as DesktopConnectionCatalogStore from "./app/DesktopConnectionCatalogStore.ts";
import * as DesktopApplicationMenu from "./window/DesktopApplicationMenu.ts";
import * as DesktopAssets from "./app/DesktopAssets.ts";
import * as DesktopBackendEndpoint from "./backend/DesktopBackendEndpoint.ts";
import * as DesktopBackendConfiguration from "./backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "./backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "./backend/DesktopLocalEnvironmentAuth.ts";
import * as DesktopEnvironment from "./app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "./app/DesktopLifecycle.ts";
import * as DesktopShutdown from "./app/DesktopShutdown.ts";
import * as DesktopObservability from "./app/DesktopObservability.ts";
import * as DesktopClientSettings from "./settings/DesktopClientSettings.ts";
import * as DesktopSavedEnvironments from "./settings/DesktopSavedEnvironments.ts";
import * as DesktopShellEnvironment from "./shell/DesktopShellEnvironment.ts";
import * as DesktopSshEnvironment from "./ssh/DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "./ssh/DesktopSshPasswordPrompts.ts";
import * as DesktopState from "./app/DesktopState.ts";
import * as BrowserSession from "./preview/BrowserSession.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as DesktopWindow from "./window/DesktopWindow.ts";

ElectronProtocol.registerDesktopSchemesAsPrivileged();

const desktopEnvironmentLayer = Layer.unwrap(
  Effect.gen(function* () {
    const metadata = yield* Effect.service(ElectronApp.ElectronApp).pipe(
      Effect.flatMap((app) => app.metadata),
    );
    const platform = yield* HostProcessPlatform;
    const processArch = yield* HostProcessArchitecture;
    return DesktopEnvironment.layer({
      dirname: __dirname,
      homeDirectory: NodeOS.homedir(),
      platform,
      processArch,
      ...metadata,
    });
  }),
);

const resolveDesktopSshCliRunner = (
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
): RemoteT3RunnerOptions => {
  const devRemoteEntryPath = Option.getOrUndefined(environment.devRemoteT3ServerEntryPath);
  if (environment.isDevelopment && devRemoteEntryPath !== undefined) {
    return {
      nodeScriptPath: devRemoteEntryPath,
      nodeEngineRange: serverPackageJson.engines.node,
    };
  }
  return {
    packageSpec: resolveRemoteT3CliPackageSpec({
      appVersion: environment.appVersion,
      isDevelopment: environment.isDevelopment,
    }),
    nodeEngineRange: serverPackageJson.engines.node,
  };
};

const desktopSshEnvironmentLayer = Layer.unwrap(
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return DesktopSshEnvironment.layer({
      resolveCliRunner: Effect.succeed(resolveDesktopSshCliRunner(environment)),
    });
  }),
);

const electronLayer = Layer.mergeAll(
  ElectronApp.layer,
  ElectronDialog.layer,
  ElectronMenu.layer,
  ElectronProtocol.layer,
  ElectronSafeStorage.layer,
  ElectronShell.layer,
  ElectronTheme.layer,
  ElectronWindow.layer,
  DesktopIpc.layer(Electron.ipcMain),
);

const desktopFoundationLayer = Layer.mergeAll(
  DesktopState.layer,
  DesktopShutdown.layer,
  DesktopClientSettings.layer,
  DesktopConnectionCatalogStore.layer.pipe(Layer.provideMerge(DesktopSavedEnvironments.layer)),
  DesktopAssets.layer,
  DesktopObservability.layer,
).pipe(Layer.provideMerge(desktopEnvironmentLayer));

const desktopSshLayer = desktopSshEnvironmentLayer.pipe(
  Layer.provideMerge(DesktopSshPasswordPrompts.layer()),
);

const desktopPreviewLayer = PreviewManager.layer.pipe(
  Layer.provideMerge(BrowserSession.layer),
  Layer.provideMerge(desktopFoundationLayer),
);

const desktopWindowLayer = DesktopWindow.layer.pipe(
  Layer.provideMerge(desktopFoundationLayer),
  Layer.provideMerge(desktopPreviewLayer),
);

// The pool owns the single local backend instance and exposes it to desktop
// lifecycle, authentication, and IPC consumers.
const desktopBackendLayer = DesktopBackendPool.layer.pipe(
  Layer.provideMerge(DesktopAppIdentity.layer),
  Layer.provideMerge(DesktopBackendConfiguration.layer),
  Layer.provideMerge(DesktopBackendEndpoint.layer),
  Layer.provideMerge(desktopWindowLayer),
);

const desktopLocalEnvironmentAuthLayer = DesktopLocalEnvironmentAuth.layer.pipe(
  Layer.provideMerge(desktopBackendLayer),
);

const desktopApplicationLayer = Layer.mergeAll(
  DesktopLifecycle.layer,
  DesktopApplicationMenu.layer,
  DesktopShellEnvironment.layer,
  desktopSshLayer,
).pipe(
  Layer.provideMerge(desktopBackendLayer),
  Layer.provideMerge(desktopLocalEnvironmentAuthLayer),
);

const desktopRuntimeLayer = desktopApplicationLayer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeHttpClient.layerUndici),
  Layer.provideMerge(NetService.layer),
  Layer.provideMerge(electronLayer),
);

DesktopApp.program.pipe(Effect.provide(desktopRuntimeLayer), NodeRuntime.runMain);
