import {
  ContextMenuItemSchema,
  DesktopAppBrandingSchema,
  DesktopEnvironmentBootstrapSchema,
  DesktopThemeSchema,
  PickFolderOptionsSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../../backend/DesktopLocalEnvironmentAuth.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronMenu from "../../electron/ElectronMenu.ts";
import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const ContextMenuPosition = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
});

const ContextMenuInput = Schema.Struct({
  items: Schema.Array(ContextMenuItemSchema),
  position: Schema.optionalKey(ContextMenuPosition),
});

function toWebSocketBaseUrl(httpBaseUrl: URL): string {
  const url = new URL(httpBaseUrl.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

export const getAppBranding = DesktopIpc.makeSyncIpcMethod({
  channel: IpcChannels.GET_APP_BRANDING_CHANNEL,
  result: Schema.NullOr(DesktopAppBrandingSchema),
  handler: Effect.fn("desktop.ipc.window.getAppBranding")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return environment.branding;
  }),
});

export const getLocalEnvironmentBootstraps = DesktopIpc.makeSyncIpcMethod({
  channel: IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL,
  result: Schema.Array(DesktopEnvironmentBootstrapSchema),
  handler: Effect.fn("desktop.ipc.window.getLocalEnvironmentBootstraps")(function* () {
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const instance = yield* pool.primary;
    const config = yield* instance.currentConfig;
    if (Option.isNone(config)) {
      return [];
    }
    const { bootstrap, httpBaseUrl } = config.value;
    return [
      {
        id: instance.id,
        label: yield* instance.label,
        httpBaseUrl: httpBaseUrl.href,
        wsBaseUrl: toWebSocketBaseUrl(httpBaseUrl),
        ...(bootstrap.desktopBootstrapToken
          ? { bootstrapToken: bootstrap.desktopBootstrapToken }
          : {}),
      },
    ];
  }),
});

export const getLocalEnvironmentBearerToken = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_LOCAL_ENVIRONMENT_BEARER_TOKEN_CHANNEL,
  payload: Schema.Void,
  result: Schema.String,
  handler: Effect.fn("desktop.ipc.window.getLocalEnvironmentBearerToken")(function* () {
    const localAuth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
    return yield* localAuth.getBearerToken;
  }),
});

export const pickFolder = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PICK_FOLDER_CHANNEL,
  payload: Schema.UndefinedOr(PickFolderOptionsSchema),
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.window.pickFolder")(function* (options) {
    const dialog = yield* ElectronDialog.ElectronDialog;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const defaultPath = environment.resolvePickFolderDefaultPath(options);
    const selectedPath = yield* dialog.pickFolder({
      owner: yield* electronWindow.focusedMainOrFirst,
      defaultPath,
    });
    return Option.getOrNull(selectedPath);
  }),
});

export const confirm = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CONFIRM_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.window.confirm")(function* (message) {
    const dialog = yield* ElectronDialog.ElectronDialog;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    return yield* electronWindow.focusedMainOrFirst.pipe(
      Effect.flatMap((owner) => dialog.confirm({ owner, message })),
    );
  }),
});

export const setTheme = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_THEME_CHANNEL,
  payload: DesktopThemeSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.window.setTheme")(function* (theme) {
    const electronTheme = yield* ElectronTheme.ElectronTheme;
    yield* electronTheme.setSource(theme);
  }),
});

export const showContextMenu = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CONTEXT_MENU_CHANNEL,
  payload: ContextMenuInput,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.window.showContextMenu")(function* (input) {
    const electronMenu = yield* ElectronMenu.ElectronMenu;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const window = yield* electronWindow.focusedMainOrFirst;
    if (Option.isNone(window)) {
      return null;
    }

    const selectedItemId = yield* electronMenu.showContextMenu({
      window: window.value,
      items: input.items,
      position: Option.fromNullishOr(input.position),
    });
    return Option.getOrNull(selectedItemId);
  }),
});

export const openExternal = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_EXTERNAL_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.window.openExternal")(function* (url) {
    const shell = yield* ElectronShell.ElectronShell;
    return yield* shell.openExternal(url);
  }),
});
