import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopBackendEndpoint from "./DesktopBackendEndpoint.ts";

const PersistedServerObservabilitySettingsDocument = Schema.Struct({
  observability: Schema.Struct({
    otlpTracesUrl: Schema.String,
    otlpMetricsUrl: Schema.String,
  }),
});

const encodePersistedServerObservabilitySettingsDocument = Schema.encodeEffect(
  Schema.fromJsonString(PersistedServerObservabilitySettingsDocument),
);

const isDesktopBackendObservabilitySettingsReadError = Schema.is(
  DesktopBackendConfiguration.DesktopBackendObservabilitySettingsReadError,
);

const backendEndpointLayer = Layer.succeed(DesktopBackendEndpoint.DesktopBackendEndpoint, {
  configure: () => Effect.die("unexpected configure"),
  current: Effect.succeed({
    port: 4888,
    bindHost: "127.0.0.1",
    httpBaseUrl: new URL("http://127.0.0.1:4888"),
  }),
} satisfies DesktopBackendEndpoint.DesktopBackendEndpoint["Service"]);

function makeEnvironmentLayer(baseDir: string, isPackaged = true) {
  return DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          T3CODE_HOME: baseDir,
          T3CODE_PORT: "9999",
          T3CODE_MODE: "desktop",
          T3CODE_DESKTOP_LAN_HOST: "192.168.1.50",
          VITE_DEV_SERVER_URL: isPackaged ? undefined : "http://127.0.0.1:5733",
        }),
      ),
    ),
  );
}

const withHarness = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    | R
    | DesktopEnvironment.DesktopEnvironment
    | FileSystem.FileSystem
    | DesktopBackendConfiguration.DesktopBackendConfiguration
  >,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "ethereal-desktop-backend-config-test-",
    });
    return yield* effect.pipe(
      Effect.provide(
        DesktopBackendConfiguration.layer.pipe(
          Layer.provideMerge(backendEndpointLayer),
          Layer.provideMerge(makeEnvironmentLayer(baseDir)),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("DesktopBackendConfiguration", () => {
  it.effect("resolves a stable local bootstrap", () =>
    withHarness(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const first = yield* configuration.resolvePrimary;
        const second = yield* configuration.resolvePrimary;

        assert.equal(first.executablePath, process.execPath);
        assert.equal(first.entryPath, environment.backendEntryPath);
        assert.equal(first.cwd, environment.backendCwd);
        assert.equal(first.captureOutput, true);
        assert.equal(first.env.ELECTRON_RUN_AS_NODE, "1");
        assert.isUndefined(first.env.T3CODE_PORT);
        assert.isUndefined(first.env.T3CODE_MODE);
        assert.isUndefined(first.env.T3CODE_DESKTOP_LAN_HOST);
        assert.equal(first.bootstrap.mode, "desktop");
        assert.equal(first.bootstrap.noBrowser, true);
        assert.equal(first.bootstrap.port, 4888);
        assert.equal(first.bootstrap.host, "127.0.0.1");
        assert.equal(first.bootstrap.t3Home, environment.baseDir);
        assert.match(first.bootstrap.desktopBootstrapToken, /^[0-9a-f]{48}$/i);
        assert.equal(second.bootstrap.desktopBootstrapToken, first.bootstrap.desktopBootstrapToken);
        assert.equal(yield* configuration.resolvePrimaryLabel, "Local environment");
      }),
    ),
  );

  it.effect("forwards persisted observability endpoints", () =>
    withHarness(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.serverSettingsPath,
          yield* encodePersistedServerObservabilitySettingsDocument({
            observability: {
              otlpTracesUrl: " http://127.0.0.1:4318/v1/traces ",
              otlpMetricsUrl: " http://127.0.0.1:4318/v1/metrics ",
            },
          }),
        );

        const config = yield* configuration.resolvePrimary;
        assert.equal(config.bootstrap.otlpTracesUrl, "http://127.0.0.1:4318/v1/traces");
        assert.equal(config.bootstrap.otlpMetricsUrl, "http://127.0.0.1:4318/v1/metrics");
      }),
    ),
  );

  it.effect("shares one token across concurrent local resolutions", () =>
    withHarness(
      Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const configs = yield* Effect.all(
          [configuration.resolvePrimary, configuration.resolvePrimary],
          { concurrency: "unbounded" },
        );

        assert.equal(
          configs[0].bootstrap.desktopBootstrapToken,
          configs[1].bootstrap.desktopBootstrapToken,
        );
      }),
    ),
  );

  it.effect("omits observability endpoints when settings are missing", () =>
    withHarness(
      Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolvePrimary;
        assert.isUndefined(config.bootstrap.otlpTracesUrl);
        assert.isUndefined(config.bootstrap.otlpMetricsUrl);
      }),
    ),
  );

  it.effect("logs structured context when persisted observability settings cannot be read", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ethereal-desktop-backend-config-test-",
      });
      const settingsPath = path.join(baseDir, "userdata", "settings.json");
      const cause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "readFileString",
        pathOrDescriptor: settingsPath,
      });
      const messages: Array<unknown> = [];
      const logger = Logger.make(({ message }) => {
        messages.push(message);
      });
      const failingFileSystemLayer = Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: () => Effect.fail(cause),
        }),
      );

      const config = yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        return yield* configuration.resolvePrimary;
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            DesktopBackendConfiguration.layer.pipe(
              Layer.provideMerge(backendEndpointLayer),
              Layer.provideMerge(makeEnvironmentLayer(baseDir)),
              Layer.provideMerge(failingFileSystemLayer),
            ),
            Logger.layer([logger], { mergeWithExisting: false }),
          ),
        ),
      );

      assert.isUndefined(config.bootstrap.otlpTracesUrl);
      assert.isUndefined(config.bootstrap.otlpMetricsUrl);

      const error = messages
        .flatMap((message) => (Array.isArray(message) ? message : [message]))
        .find(isDesktopBackendObservabilitySettingsReadError);
      assert.isDefined(error);
      assert.equal(error.settingsPath, settingsPath);
      assert.equal(error.cause, cause);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
