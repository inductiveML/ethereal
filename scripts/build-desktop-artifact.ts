#!/usr/bin/env node

import { fromYaml } from "@t3tools/shared/schemaYaml";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import rootPackageJson from "../package.json" with { type: "json" };
import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };
import serverPackageJson from "../apps/server/package.json" with { type: "json" };

import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import { getDefaultBuildArch } from "./lib/build-target-arch.ts";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";
import { createStagePnpmLock } from "./lib/stage-pnpm-lock.ts";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const DESKTOP_APP_ID = "com.t3tools.t3code";
const MACOS_SRGB_PROFILE_PATH = "/System/Library/ColorSync/Profiles/sRGB Profile.icc";
const BuildArch = Schema.Literals(["arm64", "x64"]);

const WorkspaceConfig = Schema.Struct({
  packages: Schema.optional(Schema.Array(Schema.String)),
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  packageExtensions: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  peerDependencyRules: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
});
type WorkspaceConfig = typeof WorkspaceConfig.Type;

const StageWorkspaceConfig = Schema.Struct({
  packages: Schema.optional(Schema.Array(Schema.String)),
  supportedArchitectures: Schema.Struct({
    os: Schema.Array(Schema.String),
    cpu: Schema.Array(Schema.String),
  }),
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  packageExtensions: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  peerDependencyRules: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
type StageWorkspaceConfig = typeof StageWorkspaceConfig.Type;

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);
const encodeJsonString = Schema.encodeEffect(Schema.UnknownFromJsonString);
const decodeWorkspaceConfig = Schema.decodeEffect(fromYaml(WorkspaceConfig));
const encodeStageWorkspaceConfig = Schema.encodeEffect(fromYaml(StageWorkspaceConfig));

interface DesktopBuildIconAssets {
  readonly macIconPng: string;
}

interface BuildCliInput {
  readonly arch: Option.Option<typeof BuildArch.Type>;
  readonly buildVersion: Option.Option<string>;
  readonly outputDir: Option.Option<string>;
  readonly skipBuild: Option.Option<boolean>;
  readonly keepStage: Option.Option<boolean>;
  readonly verbose: Option.Option<boolean>;
}

interface ResolvedBuildOptions {
  readonly arch: typeof BuildArch.Type;
  readonly version: string | undefined;
  readonly outputDir: string;
  readonly skipBuild: boolean;
  readonly keepStage: boolean;
  readonly verbose: boolean;
}

interface StagePackageJson {
  readonly name: string;
  readonly version: string;
  readonly buildVersion: string;
  readonly etherealCommitHash: string;
  readonly private: true;
  readonly packageManager: string;
  readonly description: string;
  readonly author: string;
  readonly main: string;
  readonly build: Record<string, unknown>;
  readonly dependencies: Record<string, string>;
  readonly devDependencies: Record<string, string>;
}

export class UnsupportedHostBuildPlatformError extends Schema.TaggedErrorClass<UnsupportedHostBuildPlatformError>()(
  "UnsupportedHostBuildPlatformError",
  {
    hostPlatform: Schema.String,
  },
) {
  override get message(): string {
    return `Desktop artifacts can only be built on macOS; detected '${this.hostPlatform}'.`;
  }
}

export class BuildCommandFailedError extends Schema.TaggedErrorClass<BuildCommandFailedError>()(
  "BuildCommandFailedError",
  {
    command: Schema.String,
    exitCode: Schema.Int,
    stdoutTail: Schema.optionalKey(Schema.String),
    stderrTail: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    const outputSections = [
      formatOutputSection("stdout", this.stdoutTail ?? ""),
      formatOutputSection("stderr", this.stderrTail ?? ""),
    ].filter((section): section is string => section !== undefined);
    const outputSuffix = outputSections.length > 0 ? `\n\n${outputSections.join("\n\n")}` : "";
    return `Command '${this.command}' exited with code ${this.exitCode}${outputSuffix}`;
  }
}

export class DesktopIconSourceMissingError extends Schema.TaggedErrorClass<DesktopIconSourceMissingError>()(
  "DesktopIconSourceMissingError",
  {
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Desktop macOS icon source is missing at ${this.sourcePath}`;
  }
}

export class BundledClientAssetsMissingError extends Schema.TaggedErrorClass<BundledClientAssetsMissingError>()(
  "BundledClientAssetsMissingError",
  {
    indexPath: Schema.String,
    missingFiles: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const preview = this.missingFiles.slice(0, 6).join(", ");
    const suffix = this.missingFiles.length > 6 ? ` (+${this.missingFiles.length - 6} more)` : "";
    return `Bundled client references missing files in ${this.indexPath}: ${preview}${suffix}. Rebuild web/server artifacts.`;
  }
}

export class DesktopBuildDependencyResolutionError extends Schema.TaggedErrorClass<DesktopBuildDependencyResolutionError>()(
  "DesktopBuildDependencyResolutionError",
  {
    kind: Schema.String,
    manifestPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not resolve ${this.kind} from ${this.manifestPath}.`;
  }
}

export class MissingServerProductionDependenciesError extends Schema.TaggedErrorClass<MissingServerProductionDependenciesError>()(
  "MissingServerProductionDependenciesError",
  {
    manifestPath: Schema.String,
  },
) {
  override get message(): string {
    return `Could not resolve production dependencies from ${this.manifestPath}.`;
  }
}

const DesktopBuildInputArtifact = Schema.Literals([
  "desktop-dist",
  "desktop-resources",
  "server-dist",
  "bundled-server-client",
]);
type DesktopBuildInputArtifact = typeof DesktopBuildInputArtifact.Type;

export class MissingDesktopBuildInputError extends Schema.TaggedErrorClass<MissingDesktopBuildInputError>()(
  "MissingDesktopBuildInputError",
  {
    artifact: DesktopBuildInputArtifact,
    artifactPath: Schema.String,
    buildCommand: Schema.String,
  },
) {
  override get message(): string {
    return `Missing ${this.artifact} at ${this.artifactPath}. Run '${this.buildCommand}'.`;
  }
}

export class DesktopBuildDistDirectoryMissingError extends Schema.TaggedErrorClass<DesktopBuildDistDirectoryMissingError>()(
  "DesktopBuildDistDirectoryMissingError",
  {
    distPath: Schema.String,
    arch: BuildArch,
  },
) {
  override get message(): string {
    return `electron-builder did not create ${this.distPath} for macOS/${this.arch}.`;
  }
}

export class DesktopBuildNoArtifactsProducedError extends Schema.TaggedErrorClass<DesktopBuildNoArtifactsProducedError>()(
  "DesktopBuildNoArtifactsProducedError",
  {
    distPath: Schema.String,
    arch: BuildArch,
  },
) {
  override get message(): string {
    return `No DMG was produced in ${this.distPath} for macOS/${this.arch}.`;
  }
}

const readWorkspaceConfig = Effect.fn("readWorkspaceConfig")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const workspaceYaml = yield* fs.readFileString(path.join(repoRoot, "pnpm-workspace.yaml"));
  return yield* decodeWorkspaceConfig(workspaceYaml);
});

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const COMMAND_OUTPUT_TAIL_LENGTH = 20_000;

function appendOutputTail(acc: string, chunk: string): string {
  const next = acc + chunk;
  return next.length > COMMAND_OUTPUT_TAIL_LENGTH ? next.slice(-COMMAND_OUTPUT_TAIL_LENGTH) : next;
}

function formatOutputSection(label: string, output: string): string | undefined {
  const trimmed = output.trim();
  return trimmed ? `${label} tail:\n${trimmed}` : undefined;
}

const collectCommandStream = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  output: NodeJS.WriteStream,
  verbose: boolean,
): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFoldEffect(
      () => "",
      (acc, chunk) =>
        Effect.as(
          verbose ? Effect.sync(() => output.write(chunk)) : Effect.void,
          appendOutputTail(acc, chunk),
        ),
    ),
  );

const spawnAndCollectOutput = Effect.fn("spawnAndCollectOutput")(function* (
  command: ChildProcess.Command,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout),
      collectStreamAsString(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, exitCode } as const;
});

const resolveGitCommitHash = Effect.fn("resolveGitCommitHash")(function* (repoRoot: string) {
  const result = yield* spawnAndCollectOutput(
    ChildProcess.make("git", ["rev-parse", "--short=12", "HEAD"], { cwd: repoRoot }),
  ).pipe(Effect.orElseSucceed(() => ({ stdout: "", stderr: "", exitCode: 1 })));
  const hash = result.stdout.trim();
  return result.exitCode === 0 && /^[0-9a-f]{7,40}$/i.test(hash) ? hash.toLowerCase() : "unknown";
});

export const STAGE_INSTALL_ARGS = ["install", "--prod", "--frozen-lockfile"] as const;
export const DESKTOP_ASAR_UNPACK = [
  "apps/server/dist/**",
  "**/node_modules/@ff-labs/fff-bin-*/**/*",
  "**/node_modules/node-pty/**/*",
] as const;

export function resolveFffNativeDependencies(
  arch: typeof BuildArch.Type,
  version: string,
): Record<string, string> {
  return { [`@ff-labs/fff-bin-darwin-${arch}`]: version };
}

export function createStageWorkspaceConfig(input: {
  readonly arch: typeof BuildArch.Type;
  readonly packages?: ReadonlyArray<string>;
  readonly catalog?: Record<string, string>;
  readonly allowBuilds?: Record<string, boolean>;
  readonly packageExtensions?: Record<string, unknown>;
  readonly patchedDependencies?: Record<string, string>;
  readonly overrides?: Record<string, string>;
  readonly peerDependencyRules?: Record<string, unknown>;
}): StageWorkspaceConfig {
  return {
    ...(input.packages && input.packages.length > 0 ? { packages: [...input.packages] } : {}),
    supportedArchitectures: {
      os: ["darwin"],
      cpu: [input.arch],
    },
    ...(input.catalog && Object.keys(input.catalog).length > 0 ? { catalog: input.catalog } : {}),
    ...(input.allowBuilds && Object.keys(input.allowBuilds).length > 0
      ? { allowBuilds: input.allowBuilds }
      : {}),
    ...(input.packageExtensions && Object.keys(input.packageExtensions).length > 0
      ? { packageExtensions: input.packageExtensions }
      : {}),
    ...(input.patchedDependencies && Object.keys(input.patchedDependencies).length > 0
      ? { patchedDependencies: input.patchedDependencies }
      : {}),
    ...(input.overrides && Object.keys(input.overrides).length > 0
      ? { overrides: input.overrides }
      : {}),
    ...(input.peerDependencyRules && Object.keys(input.peerDependencyRules).length > 0
      ? { peerDependencyRules: input.peerDependencyRules }
      : {}),
  };
}

export function createStagePatchedDependencies(
  patchedDependencies: Record<string, string>,
  dependencies: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(patchedDependencies).filter(([patchKey]) =>
      Object.hasOwn(dependencies, getPatchedDependencyPackageName(patchKey)),
    ),
  );
}

function getPatchedDependencyPackageName(patchKey: string): string {
  const versionSeparator = patchKey.lastIndexOf("@");
  return versionSeparator > 0 ? patchKey.slice(0, versionSeparator) : patchKey;
}

const BuildEnvConfig = Config.all({
  arch: Config.schema(BuildArch, "T3CODE_DESKTOP_ARCH").pipe(Config.option),
  version: Config.string("T3CODE_DESKTOP_VERSION").pipe(Config.option),
  outputDir: Config.string("T3CODE_DESKTOP_OUTPUT_DIR").pipe(Config.option),
  skipBuild: Config.boolean("T3CODE_DESKTOP_SKIP_BUILD").pipe(Config.withDefault(false)),
  keepStage: Config.boolean("T3CODE_DESKTOP_KEEP_STAGE").pipe(Config.withDefault(false)),
  verbose: Config.boolean("T3CODE_DESKTOP_VERBOSE").pipe(Config.withDefault(false)),
});

const resolveBooleanFlag = (flag: Option.Option<boolean>, envValue: boolean) =>
  Option.getOrElse(flag, () => envValue);
const mergeOptions = <A>(a: Option.Option<A>, b: Option.Option<A>, defaultValue: A) =>
  Option.getOrElse(a, () => Option.getOrElse(b, () => defaultValue));

export const resolveBuildOptions = Effect.fn("resolveBuildOptions")(function* (
  input: BuildCliInput,
) {
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const env = yield* BuildEnvConfig;
  const hostPlatform = yield* HostProcessPlatform;

  if (hostPlatform !== "darwin") {
    return yield* new UnsupportedHostBuildPlatformError({ hostPlatform });
  }

  const defaultArch = yield* getDefaultBuildArch();
  return {
    arch: mergeOptions(input.arch, env.arch, defaultArch),
    version: mergeOptions(input.buildVersion, env.version, undefined),
    outputDir: path.resolve(repoRoot, mergeOptions(input.outputDir, env.outputDir, "release")),
    skipBuild: resolveBooleanFlag(input.skipBuild, env.skipBuild),
    keepStage: resolveBooleanFlag(input.keepStage, env.keepStage),
    verbose: resolveBooleanFlag(input.verbose, env.verbose),
  } satisfies ResolvedBuildOptions;
});

const runCommand = Effect.fn("runCommand")(function* (
  command: ChildProcess.Command,
  options: {
    readonly label: string;
    readonly verbose: boolean;
  },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectCommandStream(child.stdout, process.stdout, options.verbose),
      collectCommandStream(child.stderr, process.stderr, options.verbose),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );

  if (exitCode !== 0) {
    return yield* new BuildCommandFailedError({
      command: options.label,
      exitCode,
      ...(stdout.trim() ? { stdoutTail: stdout } : {}),
      ...(stderr.trim() ? { stderrTail: stderr } : {}),
    });
  }
});

function stageMacIcons(stageResourcesDir: string, sourcePng: string, verbose: boolean) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(sourcePng))) {
      return yield* new DesktopIconSourceMissingError({ sourcePath: sourcePng });
    }

    const stagedIconPng = path.join(stageResourcesDir, "icon.png");
    // electron-builder accepts a high-resolution PNG and performs its own
    // platform conversion. Normalize the retained 16-bit Display P3 artwork
    // to an 8-bit sRGB staging copy so its image pipeline is deterministic.
    yield* runCommand(
      ChildProcess.make(
        {},
      )`sips -s format png -s formatOptions default -m ${MACOS_SRGB_PROFILE_PATH} ${sourcePng} --out ${stagedIconPng}`,
      { label: "sips normalize mac icon", verbose },
    );
  });
}

function validateBundledClientAssets(clientDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const indexPath = path.join(clientDir, "index.html");
    const indexHtml = yield* fs.readFileString(indexPath);
    const refs = [...indexHtml.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined);
    const missing: string[] = [];

    for (const ref of refs) {
      const normalizedRef = ref.split("#")[0]?.split("?")[0] ?? "";
      if (!normalizedRef || /^(?:https?:|data:|mailto:)/.test(normalizedRef)) continue;
      if (!path.extname(normalizedRef)) continue;
      const assetPath = path.join(clientDir, normalizedRef.replace(/^\/+/, ""));
      if (!(yield* fs.exists(assetPath))) missing.push(normalizedRef);
    }

    if (missing.length > 0) {
      return yield* new BundledClientAssetsMissingError({ indexPath, missingFiles: missing });
    }
  });
}

export function resolveDesktopRuntimeDependencies(
  dependencies: Record<string, string> | undefined,
  catalog: Record<string, string>,
): Record<string, string> {
  if (!dependencies || Object.keys(dependencies).length === 0) return {};
  const runtimeDependencies = Object.fromEntries(
    Object.entries(dependencies).filter(
      ([dependencyName, dependencySpec]) =>
        dependencyName !== "electron" && !dependencySpec.startsWith("workspace:"),
    ),
  );
  return resolveCatalogDependencies(runtimeDependencies, catalog, "apps/desktop");
}

export function resolveDesktopBuildIconAssets(): DesktopBuildIconAssets {
  return { macIconPng: BRAND_ASSET_PATHS.productionMacIconPng };
}

export function resolvePackageManagerUserAgent(packageManager: string): string {
  const trimmed = packageManager.trim();
  const versionSeparator = trimmed.lastIndexOf("@");
  if (versionSeparator <= 0 || versionSeparator === trimmed.length - 1) return trimmed;
  return `${trimmed.slice(0, versionSeparator)}/${trimmed.slice(versionSeparator + 1)}`;
}

export function resolveDesktopProductName(): string {
  return desktopPackageJson.productName ?? "Ethereal";
}

export function createBuildConfig(): Record<string, unknown> {
  return {
    appId: DESKTOP_APP_ID,
    productName: resolveDesktopProductName(),
    artifactName: "Ethereal-${version}-${arch}.${ext}",
    directories: {
      buildResources: "apps/desktop/resources",
    },
    asarUnpack: [...DESKTOP_ASAR_UNPACK],
    mac: {
      target: ["dmg"],
      icon: "icon.png",
      category: "public.app-category.developer-tools",
      protocols: [
        {
          name: "Ethereal",
          schemes: ["t3code", "t3code-dev"],
        },
      ],
    },
  };
}

const buildDesktopArtifact = Effect.fn("buildDesktopArtifact")(function* (
  options: ResolvedBuildOptions,
) {
  const repoRoot = yield* RepoRoot;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const workspaceConfig = yield* readWorkspaceConfig();
  const workspacePackages = workspaceConfig.packages ?? [];
  const workspaceCatalog = workspaceConfig.catalog ?? {};
  const workspaceOverrides = workspaceConfig.overrides ?? {};
  const workspacePackageExtensions = workspaceConfig.packageExtensions ?? {};
  const workspacePatchedDependencies = workspaceConfig.patchedDependencies ?? {};
  const workspacePeerDependencyRules = workspaceConfig.peerDependencyRules ?? {};
  const workspaceAllowBuilds = workspaceConfig.allowBuilds ?? {};

  const serverDependencies = serverPackageJson.dependencies;
  if (!serverDependencies || Object.keys(serverDependencies).length === 0) {
    return yield* new MissingServerProductionDependenciesError({
      manifestPath: "apps/server/package.json",
    });
  }

  const resolvedServerDependencies = yield* Effect.try({
    try: () => resolveCatalogDependencies(serverDependencies, workspaceCatalog, "apps/server"),
    catch: (cause) =>
      new DesktopBuildDependencyResolutionError({
        kind: "server production dependencies",
        manifestPath: "apps/server/package.json",
        cause,
      }),
  });
  const resolvedDesktopRuntimeDependencies = yield* Effect.try({
    try: () => resolveDesktopRuntimeDependencies(desktopPackageJson.dependencies, workspaceCatalog),
    catch: (cause) =>
      new DesktopBuildDependencyResolutionError({
        kind: "desktop runtime dependencies",
        manifestPath: "apps/desktop/package.json",
        cause,
      }),
  });
  const fffVersion = serverPackageJson.dependencies["@ff-labs/fff-node"];
  const requestedStageDependencies = {
    ...resolvedServerDependencies,
    ...resolvedDesktopRuntimeDependencies,
    ...resolveFffNativeDependencies(options.arch, fffVersion),
  };
  const stagePatchedDependencies = createStagePatchedDependencies(
    workspacePatchedDependencies,
    requestedStageDependencies,
  );
  const rootLockfileYaml = yield* fs.readFileString(path.join(repoRoot, "pnpm-lock.yaml"));
  const stagePnpmLock = yield* Effect.try({
    try: () =>
      createStagePnpmLock(rootLockfileYaml, {
        dependencySources: [
          { importer: "apps/server", names: Object.keys(resolvedServerDependencies) },
          {
            importer: "apps/desktop",
            names: Object.keys(resolvedDesktopRuntimeDependencies),
          },
        ],
        devDependencySources: [
          {
            importer: "apps/desktop",
            names: ["electron"],
            sourceKind: "dependencies",
          },
        ],
        extraDependencies: resolveFffNativeDependencies(options.arch, fffVersion),
        patchedDependencyKeys: Object.keys(stagePatchedDependencies),
      }),
    catch: (cause) =>
      new DesktopBuildDependencyResolutionError({
        kind: "staged dependencies",
        manifestPath: "pnpm-lock.yaml",
        cause,
      }),
  });

  const appVersion = options.version ?? serverPackageJson.version;
  const commitHash = yield* resolveGitCommitHash(repoRoot);
  const mkdir = options.keepStage ? fs.makeTempDirectory : fs.makeTempDirectoryScoped;
  const stageRoot = yield* mkdir({ prefix: "ethereal-desktop-macos-stage-" });
  const stageAppDir = path.join(stageRoot, "app");
  const stageResourcesDir = path.join(stageAppDir, "apps/desktop/resources");
  const distDirs = {
    desktopDist: path.join(repoRoot, "apps/desktop/dist-electron"),
    desktopResources: path.join(repoRoot, "apps/desktop/resources"),
    serverDist: path.join(repoRoot, "apps/server/dist"),
  };
  const bundledClientEntry = path.join(distDirs.serverDist, "client/index.html");

  if (!options.skipBuild) {
    yield* Effect.log("[desktop-artifact] Building desktop/server/web artifacts...");
    const spawnCommand = yield* resolveSpawnCommand("vp", ["run", "build:desktop"]);
    yield* runCommand(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: repoRoot,
        shell: spawnCommand.shell,
      }),
      { label: "vp run build:desktop", verbose: options.verbose },
    );
  }

  const requiredBuildInputs = [
    { artifact: "desktop-dist", artifactPath: distDirs.desktopDist },
    { artifact: "desktop-resources", artifactPath: distDirs.desktopResources },
    { artifact: "server-dist", artifactPath: distDirs.serverDist },
  ] as const;
  for (const input of requiredBuildInputs) {
    if (!(yield* fs.exists(input.artifactPath))) {
      return yield* new MissingDesktopBuildInputError({
        ...input,
        buildCommand: "vp run build:desktop",
      });
    }
  }
  if (!(yield* fs.exists(bundledClientEntry))) {
    return yield* new MissingDesktopBuildInputError({
      artifact: "bundled-server-client",
      artifactPath: bundledClientEntry,
      buildCommand: "vp run build:desktop",
    });
  }
  yield* validateBundledClientAssets(path.dirname(bundledClientEntry));

  yield* fs.makeDirectory(path.join(stageAppDir, "apps/desktop"), { recursive: true });
  yield* fs.makeDirectory(path.join(stageAppDir, "apps/server"), { recursive: true });
  yield* Effect.log("[desktop-artifact] Staging release app...");
  yield* fs.copy(distDirs.desktopDist, path.join(stageAppDir, "apps/desktop/dist-electron"));
  yield* fs.copy(distDirs.desktopResources, stageResourcesDir);
  yield* fs.copy(distDirs.serverDist, path.join(stageAppDir, "apps/server/dist"));
  const iconPath = path.join(repoRoot, resolveDesktopBuildIconAssets().macIconPng);
  yield* stageMacIcons(stageResourcesDir, iconPath, options.verbose);
  yield* fs.copy(stageResourcesDir, path.join(stageAppDir, "apps/desktop/prod-resources"));

  const stagePackageJson: StagePackageJson = {
    name: "ethereal",
    version: appVersion,
    buildVersion: appVersion,
    etherealCommitHash: commitHash,
    private: true,
    packageManager: rootPackageJson.packageManager,
    description: "A highly ethereal desktop coding workspace.",
    author: "Ethereal",
    main: "apps/desktop/dist-electron/main.cjs",
    build: createBuildConfig(),
    dependencies: stagePnpmLock.dependencies,
    devDependencies: stagePnpmLock.devDependencies,
  };

  const stagePackageJsonString = yield* encodeJsonString(stagePackageJson);
  yield* fs.writeFileString(path.join(stageAppDir, "package.json"), `${stagePackageJsonString}\n`);
  yield* fs.writeFileString(path.join(stageAppDir, "pnpm-lock.yaml"), stagePnpmLock.lockfileYaml);
  const stageWorkspaceConfig = createStageWorkspaceConfig({
    arch: options.arch,
    packages: workspacePackages,
    catalog: workspaceCatalog,
    allowBuilds: workspaceAllowBuilds,
    packageExtensions: workspacePackageExtensions,
    patchedDependencies: stagePatchedDependencies,
    overrides: workspaceOverrides,
    peerDependencyRules: workspacePeerDependencyRules,
  });
  const stageWorkspaceConfigString = yield* encodeStageWorkspaceConfig(stageWorkspaceConfig);
  yield* fs.writeFileString(
    path.join(stageAppDir, "pnpm-workspace.yaml"),
    stageWorkspaceConfigString,
  );
  if (Object.keys(stagePatchedDependencies).length > 0) {
    yield* fs.copy(path.join(repoRoot, "patches"), path.join(stageAppDir, "patches"));
  }

  yield* Effect.log("[desktop-artifact] Installing staged production dependencies...");
  const installCommand = yield* resolveSpawnCommand("vp", [...STAGE_INSTALL_ARGS]);
  yield* runCommand(
    ChildProcess.make(installCommand.command, installCommand.args, {
      cwd: stageAppDir,
      shell: installCommand.shell,
    }),
    { label: "vp install --prod --frozen-lockfile", verbose: options.verbose },
  );

  const buildEnv: NodeJS.ProcessEnv = { ...process.env };
  buildEnv.npm_config_user_agent = resolvePackageManagerUserAgent(rootPackageJson.packageManager);
  buildEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  delete buildEnv.CSC_LINK;
  delete buildEnv.CSC_KEY_PASSWORD;
  delete buildEnv.APPLE_API_KEY;
  delete buildEnv.APPLE_API_KEY_ID;
  delete buildEnv.APPLE_API_ISSUER;
  for (const [key, value] of Object.entries(buildEnv)) {
    if (value === "") delete buildEnv[key];
  }
  if (options.verbose) {
    buildEnv.DEBUG = buildEnv.DEBUG
      ? `${buildEnv.DEBUG},electron-builder,electron-builder:*`
      : "electron-builder,electron-builder:*";
  }

  yield* Effect.log(
    `[desktop-artifact] Building macOS DMG (arch=${options.arch}, version=${appVersion})...`,
  );
  const builderArgs = [
    "exec",
    "--filter",
    "@t3tools/desktop",
    "--",
    "electron-builder",
    "--projectDir",
    stageAppDir,
    "--mac",
    `--${options.arch}`,
  ];
  const builderCommand = yield* resolveSpawnCommand("vp", builderArgs, { env: buildEnv });
  yield* runCommand(
    ChildProcess.make(builderCommand.command, builderCommand.args, {
      cwd: repoRoot,
      env: buildEnv,
      shell: builderCommand.shell,
    }),
    {
      label: `vp exec --filter @t3tools/desktop -- electron-builder --projectDir ${stageAppDir} --mac --${options.arch}`,
      verbose: options.verbose,
    },
  );

  const stageDistDir = path.join(stageAppDir, "dist");
  if (!(yield* fs.exists(stageDistDir))) {
    return yield* new DesktopBuildDistDirectoryMissingError({
      distPath: stageDistDir,
      arch: options.arch,
    });
  }

  yield* fs.makeDirectory(options.outputDir, { recursive: true });
  const copiedArtifacts: string[] = [];
  for (const entry of yield* fs.readDirectory(stageDistDir)) {
    if (!entry.toLowerCase().endsWith(".dmg")) continue;
    const from = path.join(stageDistDir, entry);
    const stat = yield* fs.stat(from).pipe(Effect.orElseSucceed(() => null));
    if (!stat || stat.type !== "File") continue;
    const to = path.join(options.outputDir, entry);
    yield* fs.copyFile(from, to);
    copiedArtifacts.push(to);
  }
  if (copiedArtifacts.length === 0) {
    return yield* new DesktopBuildNoArtifactsProducedError({
      distPath: stageDistDir,
      arch: options.arch,
    });
  }

  yield* Effect.log("[desktop-artifact] Done.").pipe(
    Effect.annotateLogs({ artifacts: copiedArtifacts }),
  );
});

const buildDesktopArtifactCli = Command.make("build-desktop-artifact", {
  arch: Flag.choice("arch", BuildArch.literals).pipe(
    Flag.withDescription("macOS artifact architecture (env: T3CODE_DESKTOP_ARCH)."),
    Flag.optional,
  ),
  buildVersion: Flag.string("build-version").pipe(
    Flag.withDescription("Artifact version metadata (env: T3CODE_DESKTOP_VERSION)."),
    Flag.optional,
  ),
  outputDir: Flag.string("output-dir").pipe(
    Flag.withDescription("Output directory for artifacts (env: T3CODE_DESKTOP_OUTPUT_DIR)."),
    Flag.optional,
  ),
  skipBuild: Flag.boolean("skip-build").pipe(
    Flag.withDescription(
      "Use existing dist artifacts instead of running the desktop build (env: T3CODE_DESKTOP_SKIP_BUILD).",
    ),
    Flag.optional,
  ),
  keepStage: Flag.boolean("keep-stage").pipe(
    Flag.withDescription("Keep temporary staging files (env: T3CODE_DESKTOP_KEEP_STAGE)."),
    Flag.optional,
  ),
  verbose: Flag.boolean("verbose").pipe(
    Flag.withDescription("Stream subprocess output (env: T3CODE_DESKTOP_VERBOSE)."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Build an unsigned Ethereal macOS DMG."),
  Command.withHandler((input) => Effect.flatMap(resolveBuildOptions(input), buildDesktopArtifact)),
);

const cliRuntimeLayer = Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer);

if (import.meta.main) {
  Command.run(buildDesktopArtifactCli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(cliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
