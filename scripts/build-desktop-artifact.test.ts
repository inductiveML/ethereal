import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import {
  createBuildConfig,
  createStagePatchedDependencies,
  createStageWorkspaceConfig,
  DESKTOP_ASAR_UNPACK,
  resolveBuildOptions,
  resolveDesktopBuildIconAssets,
  resolveDesktopProductName,
  resolveDesktopRuntimeDependencies,
  resolveFffNativeDependencies,
  resolvePackageManagerUserAgent,
  STAGE_INSTALL_ARGS,
} from "./build-desktop-artifact.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

const emptyInput = {
  arch: Option.none(),
  buildVersion: Option.none(),
  outputDir: Option.none(),
  skipBuild: Option.none(),
  keepStage: Option.none(),
  verbose: Option.none(),
};

const hostAndEnvLayer = (
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  env: Readonly<Record<string, string>> = {},
) =>
  Layer.mergeAll(
    Layer.succeed(HostProcessPlatform, platform),
    Layer.succeed(HostProcessArchitecture, arch),
    ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
  );

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it("omits bundled workspace packages and Electron from staged runtime dependencies", () => {
    assert.deepStrictEqual(
      resolveDesktopRuntimeDependencies(
        {
          "@effect/platform-node": "catalog:",
          "@t3tools/contracts": "workspace:*",
          effect: "catalog:",
          electron: "41.5.0",
        },
        {
          "@effect/platform-node": "4.0.0-beta.78",
          effect: "4.0.0-beta.78",
        },
      ),
      {
        "@effect/platform-node": "4.0.0-beta.78",
        effect: "4.0.0-beta.78",
      },
    );
  });

  it("carries patch metadata only for staged dependencies", () => {
    assert.deepStrictEqual(
      createStagePatchedDependencies(
        {
          "@ff-labs/fff-node@0.9.4": "patches/@ff-labs__fff-node@0.9.4.patch",
          "effect@4.0.0-beta.78": "patches/effect@4.0.0-beta.78.patch",
          "unused-tool@1.0.0": "patches/unused-tool@1.0.0.patch",
        },
        {
          "@ff-labs/fff-node": "0.9.4",
          effect: "4.0.0-beta.78",
        },
      ),
      {
        "@ff-labs/fff-node@0.9.4": "patches/@ff-labs__fff-node@0.9.4.patch",
        "effect@4.0.0-beta.78": "patches/effect@4.0.0-beta.78.patch",
      },
    );
  });

  it("stages only the requested macOS architecture and required pnpm metadata", () => {
    assert.deepStrictEqual(STAGE_INSTALL_ARGS, ["install", "--prod", "--frozen-lockfile"]);
    assert.deepStrictEqual(
      createStageWorkspaceConfig({
        arch: "arm64",
        packages: ["apps/*", "packages/*"],
        catalog: { effect: "4.0.0-beta.78" },
        allowBuilds: { electron: true, "node-pty": true },
        packageExtensions: {
          "vite-plus@*": { dependencies: { vite: "catalog:" } },
        },
        patchedDependencies: {
          "effect@4.0.0-beta.78": "patches/effect@4.0.0-beta.78.patch",
        },
        overrides: { effect: "4.0.0-beta.78" },
        peerDependencyRules: { allowAny: ["vite"] },
      }),
      {
        packages: ["apps/*", "packages/*"],
        supportedArchitectures: { os: ["darwin"], cpu: ["arm64"] },
        catalog: { effect: "4.0.0-beta.78" },
        allowBuilds: { electron: true, "node-pty": true },
        packageExtensions: {
          "vite-plus@*": { dependencies: { vite: "catalog:" } },
        },
        patchedDependencies: {
          "effect@4.0.0-beta.78": "patches/effect@4.0.0-beta.78.patch",
        },
        overrides: { effect: "4.0.0-beta.78" },
        peerDependencyRules: { allowAny: ["vite"] },
      },
    );
    assert.deepStrictEqual(createStageWorkspaceConfig({ arch: "x64" }), {
      supportedArchitectures: { os: ["darwin"], cpu: ["x64"] },
    });
  });

  it("keeps native terminal and file-finder binaries outside the asar", () => {
    assert.deepStrictEqual(DESKTOP_ASAR_UNPACK, [
      "apps/server/dist/**",
      "**/node_modules/@ff-labs/fff-bin-*/**/*",
      "**/node_modules/node-pty/**/*",
    ]);
    assert.deepStrictEqual(resolveFffNativeDependencies("arm64", "0.9.4"), {
      "@ff-labs/fff-bin-darwin-arm64": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("x64", "0.9.4"), {
      "@ff-labs/fff-bin-darwin-x64": "0.9.4",
    });
  });

  it("uses Ethereal branding while retaining existing protocol identity", () => {
    assert.equal(resolveDesktopProductName(), "Ethereal");
    assert.deepStrictEqual(resolveDesktopBuildIconAssets(), {
      macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
    });

    const config = createBuildConfig();
    assert.equal(config.appId, "com.t3tools.t3code");
    assert.equal(config.productName, "Ethereal");
    assert.equal(config.artifactName, "Ethereal-${version}-${arch}.${ext}");
    assert.deepStrictEqual(config.mac, {
      target: ["dmg"],
      icon: "icon.png",
      category: "public.app-category.developer-tools",
      protocols: [
        {
          name: "Ethereal",
          schemes: ["t3code", "t3code-dev"],
        },
      ],
    });
    assert.isFalse(Object.hasOwn(config, "win"));
    assert.isFalse(Object.hasOwn(config, "linux"));
    assert.isFalse(Object.hasOwn(config, "publish"));
  });

  it("formats package manager metadata for electron-builder", () => {
    assert.equal(resolvePackageManagerUserAgent("pnpm@11.10.0"), "pnpm/11.10.0");
    assert.equal(resolvePackageManagerUserAgent("custom"), "custom");
  });

  it.effect("defaults to the Apple Silicon DMG on an Apple Silicon host", () =>
    Effect.gen(function* () {
      const options = yield* resolveBuildOptions(emptyInput).pipe(
        Effect.provide(hostAndEnvLayer("darwin", "arm64")),
      );

      assert.equal(options.arch, "arm64");
      assert.equal(options.version, undefined);
      assert.isTrue(options.outputDir.endsWith("/release"));
      assert.isFalse(options.skipBuild);
      assert.isFalse(options.keepStage);
      assert.isFalse(options.verbose);
    }),
  );

  it.effect("lets explicit false flags override true environment values", () =>
    Effect.gen(function* () {
      const options = yield* resolveBuildOptions({
        ...emptyInput,
        arch: Option.some("x64" as const),
        skipBuild: Option.some(false),
        keepStage: Option.some(false),
        verbose: Option.some(false),
      }).pipe(
        Effect.provide(
          hostAndEnvLayer("darwin", "arm64", {
            T3CODE_DESKTOP_SKIP_BUILD: "true",
            T3CODE_DESKTOP_KEEP_STAGE: "true",
            T3CODE_DESKTOP_VERBOSE: "true",
          }),
        ),
      );

      assert.equal(options.arch, "x64");
      assert.isFalse(options.skipBuild);
      assert.isFalse(options.keepStage);
      assert.isFalse(options.verbose);
    }),
  );

  it.effect("rejects non-macOS artifact hosts", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        resolveBuildOptions(emptyInput).pipe(Effect.provide(hostAndEnvLayer("linux", "x64"))),
      );

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.equal(result.failure._tag, "UnsupportedHostBuildPlatformError");
      }
    }),
  );
});
