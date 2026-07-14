import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

type UnknownRecord = Record<string, unknown>;

interface LockedDependency {
  readonly specifier: string;
  readonly version: string;
}

export interface StageDependencySource {
  readonly importer: string;
  readonly names: ReadonlyArray<string>;
  readonly sourceKind?: "dependencies" | "devDependencies";
}

export interface CreateStagePnpmLockInput {
  readonly dependencySources: ReadonlyArray<StageDependencySource>;
  readonly devDependencySources: ReadonlyArray<StageDependencySource>;
  readonly extraDependencies?: Readonly<Record<string, string>>;
  readonly patchedDependencyKeys?: ReadonlyArray<string>;
}

export interface StagePnpmLock {
  readonly dependencies: Record<string, string>;
  readonly devDependencies: Record<string, string>;
  readonly lockfileYaml: string;
}

export class StagePnpmLockResolutionError extends Error {
  override readonly name = "StagePnpmLockResolutionError";
}

function requireRecord(value: unknown, path: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StagePnpmLockResolutionError(`Expected an object at '${path}' in pnpm-lock.yaml.`);
  }
  return value as UnknownRecord;
}

function requireLockedDependency(value: unknown, path: string): LockedDependency {
  const entry = requireRecord(value, path);
  if (typeof entry.specifier !== "string" || typeof entry.version !== "string") {
    throw new StagePnpmLockResolutionError(
      `Expected string specifier and version fields at '${path}' in pnpm-lock.yaml.`,
    );
  }
  return { specifier: entry.specifier, version: entry.version };
}

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function exactVersionFromLockResolution(name: string, lockedVersion: string): string {
  const exactVersion = lockedVersion.slice(
    0,
    lockedVersion.indexOf("(") < 0 ? undefined : lockedVersion.indexOf("("),
  );
  if (!EXACT_SEMVER.test(exactVersion)) {
    throw new StagePnpmLockResolutionError(
      `Dependency '${name}' has unsupported lockfile resolution '${lockedVersion}'; expected an exact semver resolution.`,
    );
  }
  return exactVersion;
}

function resolveSources(
  importers: UnknownRecord,
  sources: ReadonlyArray<StageDependencySource>,
  dependencyKind: "dependencies" | "devDependencies",
): {
  readonly manifest: Record<string, string>;
  readonly importer: Record<string, LockedDependency>;
} {
  const manifest: Record<string, string> = {};
  const importer: Record<string, LockedDependency> = {};

  for (const source of sources) {
    const sourceKind = source.sourceKind ?? dependencyKind;
    const sourceImporter = requireRecord(
      importers[source.importer],
      `importers.${source.importer}`,
    );
    const sourceDependencies = requireRecord(
      sourceImporter[sourceKind],
      `importers.${source.importer}.${sourceKind}`,
    );

    for (const dependencyName of source.names) {
      const locked = requireLockedDependency(
        sourceDependencies[dependencyName],
        `importers.${source.importer}.${sourceKind}.${dependencyName}`,
      );
      const exactVersion = exactVersionFromLockResolution(dependencyName, locked.version);
      const previous = importer[dependencyName];
      if (previous !== undefined && previous.version !== locked.version) {
        throw new StagePnpmLockResolutionError(
          `Dependency '${dependencyName}' resolves differently across staged importers ('${previous.version}' and '${locked.version}').`,
        );
      }
      manifest[dependencyName] = exactVersion;
      importer[dependencyName] = { specifier: exactVersion, version: locked.version };
    }
  }

  return { manifest, importer };
}

function resolveExtraDependencies(
  packages: UnknownRecord,
  extraDependencies: Readonly<Record<string, string>>,
): {
  readonly manifest: Record<string, string>;
  readonly importer: Record<string, LockedDependency>;
} {
  const manifest: Record<string, string> = {};
  const importer: Record<string, LockedDependency> = {};

  for (const [dependencyName, exactVersion] of Object.entries(extraDependencies)) {
    if (!EXACT_SEMVER.test(exactVersion)) {
      throw new StagePnpmLockResolutionError(
        `Extra dependency '${dependencyName}' must use an exact semver, received '${exactVersion}'.`,
      );
    }
    const packageKey = `${dependencyName}@${exactVersion}`;
    if (!Object.hasOwn(packages, packageKey)) {
      throw new StagePnpmLockResolutionError(
        `Extra dependency '${dependencyName}' at '${exactVersion}' is absent from the committed pnpm lockfile.`,
      );
    }
    manifest[dependencyName] = exactVersion;
    importer[dependencyName] = { specifier: exactVersion, version: exactVersion };
  }

  return { manifest, importer };
}

function filterPatchedDependencies(
  lockfile: UnknownRecord,
  patchedDependencyKeys: ReadonlyArray<string>,
): UnknownRecord {
  if (patchedDependencyKeys.length === 0) {
    const { patchedDependencies: _, ...withoutPatchedDependencies } = lockfile;
    return withoutPatchedDependencies;
  }

  const rootPatchedDependencies = requireRecord(
    lockfile.patchedDependencies,
    "patchedDependencies",
  );
  const stagedPatchedDependencies: UnknownRecord = {};
  for (const patchKey of patchedDependencyKeys) {
    if (!Object.hasOwn(rootPatchedDependencies, patchKey)) {
      throw new StagePnpmLockResolutionError(
        `Patch '${patchKey}' is absent from the committed pnpm lockfile metadata.`,
      );
    }
    stagedPatchedDependencies[patchKey] = rootPatchedDependencies[patchKey];
  }
  return { ...lockfile, patchedDependencies: stagedPatchedDependencies };
}

/**
 * Creates a standalone frozen lockfile for the desktop packaging stage.
 *
 * Direct dependency specs are pinned to the exact versions selected by the
 * committed root lockfile, while the complete package/snapshot graph is kept
 * so transitive dependency resolution cannot drift during release packaging.
 */
export function createStagePnpmLock(
  rootLockfileYaml: string,
  input: CreateStagePnpmLockInput,
): StagePnpmLock {
  let parsed: unknown;
  try {
    parsed = parseYaml(rootLockfileYaml);
  } catch (cause) {
    throw new StagePnpmLockResolutionError(
      `Could not parse pnpm-lock.yaml: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const rootLockfile = requireRecord(parsed, "root");
  const importers = requireRecord(rootLockfile.importers, "importers");
  const packages = requireRecord(rootLockfile.packages, "packages");
  const dependencies = resolveSources(importers, input.dependencySources, "dependencies");
  const devDependencies = resolveSources(importers, input.devDependencySources, "devDependencies");
  const extraDependencies = resolveExtraDependencies(packages, input.extraDependencies ?? {});
  const duplicateExtraDependency = Object.keys(extraDependencies.importer).find((name) =>
    Object.hasOwn(dependencies.importer, name),
  );
  if (duplicateExtraDependency !== undefined) {
    throw new StagePnpmLockResolutionError(
      `Extra dependency '${duplicateExtraDependency}' is already supplied by a staged importer.`,
    );
  }

  const stageDependencies = {
    ...dependencies.manifest,
    ...extraDependencies.manifest,
  };
  const stageImporter = {
    dependencies: {
      ...dependencies.importer,
      ...extraDependencies.importer,
    },
    devDependencies: devDependencies.importer,
  };
  const filteredLockfile = filterPatchedDependencies(
    rootLockfile,
    input.patchedDependencyKeys ?? [],
  );
  const stageLockfile = {
    ...filteredLockfile,
    importers: { ".": stageImporter },
  };

  return {
    dependencies: stageDependencies,
    devDependencies: devDependencies.manifest,
    lockfileYaml: stringifyYaml(stageLockfile, { lineWidth: 0 }),
  };
}
