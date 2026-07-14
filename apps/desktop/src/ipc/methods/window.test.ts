import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import { getLocalEnvironmentBootstraps } from "./window.ts";

const readyConfig: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: "/electron",
  args: ["/app/bin.mjs", "--bootstrap-fd", "3"],
  entryPath: "/app/bin.mjs",
  cwd: "/app",
  env: {},
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3773,
    t3Home: "/tmp/t3",
    host: "127.0.0.1",
    desktopBootstrapToken: "bootstrap-token",
  },
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  captureOutput: true,
};

const primaryInstance: DesktopBackendManager.DesktopBackendInstance = {
  id: DesktopBackendManager.PRIMARY_INSTANCE_ID,
  label: Effect.succeed("Local environment"),
  start: Effect.void,
  stop: () => Effect.void,
  currentConfig: Effect.succeed(Option.some(readyConfig)),
  snapshot: Effect.succeed({
    desiredRunning: true,
    ready: true,
    activePid: Option.some(123),
    restartAttempt: 0,
    restartScheduled: false,
  }),
  waitForReady: () => Effect.succeed(true),
};

describe("getLocalEnvironmentBootstraps", () => {
  it.effect("publishes the ready local backend", () =>
    Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();
      assert.deepEqual(result, [
        {
          id: "primary",
          label: "Local environment",
          httpBaseUrl: "http://127.0.0.1:3773/",
          wsBaseUrl: "ws://127.0.0.1:3773/",
          bootstrapToken: "bootstrap-token",
        },
      ]);
    }).pipe(Effect.provide(DesktopBackendPool.layerTest([primaryInstance]))),
  );

  it.effect("omits the local backend before a config is available", () =>
    Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();
      assert.deepEqual(result, []);
    }).pipe(
      Effect.provide(
        DesktopBackendPool.layerTest([
          { ...primaryInstance, currentConfig: Effect.succeed(Option.none()) },
        ]),
      ),
    ),
  );
});
