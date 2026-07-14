import { assert, it } from "@effect/vitest";
import { parse as parseYaml } from "yaml";

import { createStagePnpmLock, StagePnpmLockResolutionError } from "./stage-pnpm-lock.ts";

const rootLockfileFixture = `
lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
patchedDependencies:
  effect@4.0.0-beta.78: effect-patch-hash
  unused-tool@1.0.0: unused-patch-hash
importers:
  apps/server:
    dependencies:
      '@anthropic-ai/claude-agent-sdk':
        specifier: ^0.3.170
        version: 0.3.170(peer@1.0.0)
      '@opencode-ai/sdk':
        specifier: ^1.3.15
        version: 1.15.13
      effect:
        specifier: 4.0.0-beta.78
        version: 4.0.0-beta.78(patch_hash=effect-patch-hash)
  apps/desktop:
    dependencies:
      effect:
        specifier: 4.0.0-beta.78
        version: 4.0.0-beta.78(patch_hash=effect-patch-hash)
      react-grab:
        specifier: ^0.1.32
        version: 0.1.44(react@19.2.6)
      electron:
        specifier: 41.5.0
        version: 41.5.0
packages:
  '@anthropic-ai/claude-agent-sdk@0.3.170': {}
  '@ff-labs/fff-bin-darwin-arm64@0.9.4': {}
  '@opencode-ai/sdk@1.15.13': {}
  effect@4.0.0-beta.78: {}
  electron@41.5.0: {}
  react-grab@0.1.44: {}
snapshots:
  '@anthropic-ai/claude-agent-sdk@0.3.170(peer@1.0.0)': {}
  '@ff-labs/fff-bin-darwin-arm64@0.9.4': {}
  '@opencode-ai/sdk@1.15.13': {}
  effect@4.0.0-beta.78(patch_hash=effect-patch-hash): {}
  electron@41.5.0: {}
  react-grab@0.1.44(react@19.2.6): {}
`;

it("pins staged direct and transitive resolution to the committed lockfile", () => {
  const result = createStagePnpmLock(rootLockfileFixture, {
    dependencySources: [
      {
        importer: "apps/server",
        names: ["@anthropic-ai/claude-agent-sdk", "@opencode-ai/sdk", "effect"],
      },
      { importer: "apps/desktop", names: ["effect", "react-grab"] },
    ],
    devDependencySources: [
      { importer: "apps/desktop", names: ["electron"], sourceKind: "dependencies" },
    ],
    extraDependencies: { "@ff-labs/fff-bin-darwin-arm64": "0.9.4" },
    patchedDependencyKeys: ["effect@4.0.0-beta.78"],
  });

  assert.deepStrictEqual(result.dependencies, {
    "@anthropic-ai/claude-agent-sdk": "0.3.170",
    "@opencode-ai/sdk": "1.15.13",
    effect: "4.0.0-beta.78",
    "react-grab": "0.1.44",
    "@ff-labs/fff-bin-darwin-arm64": "0.9.4",
  });
  assert.deepStrictEqual(result.devDependencies, { electron: "41.5.0" });

  const stageLockfile = parseYaml(result.lockfileYaml) as {
    readonly importers: Record<string, unknown>;
    readonly packages: Record<string, unknown>;
    readonly snapshots: Record<string, unknown>;
    readonly patchedDependencies: Record<string, string>;
  };
  assert.deepStrictEqual(Object.keys(stageLockfile.importers), ["."]);
  assert.deepInclude(stageLockfile.importers["."], {
    dependencies: {
      "@anthropic-ai/claude-agent-sdk": {
        specifier: "0.3.170",
        version: "0.3.170(peer@1.0.0)",
      },
      "@opencode-ai/sdk": { specifier: "1.15.13", version: "1.15.13" },
      effect: {
        specifier: "4.0.0-beta.78",
        version: "4.0.0-beta.78(patch_hash=effect-patch-hash)",
      },
      "react-grab": { specifier: "0.1.44", version: "0.1.44(react@19.2.6)" },
      "@ff-labs/fff-bin-darwin-arm64": { specifier: "0.9.4", version: "0.9.4" },
    },
    devDependencies: {
      electron: { specifier: "41.5.0", version: "41.5.0" },
    },
  });
  assert.isTrue(Object.hasOwn(stageLockfile.packages, "@anthropic-ai/claude-agent-sdk@0.3.170"));
  assert.isTrue(
    Object.hasOwn(stageLockfile.snapshots, "@anthropic-ai/claude-agent-sdk@0.3.170(peer@1.0.0)"),
  );
  assert.deepStrictEqual(stageLockfile.patchedDependencies, {
    "effect@4.0.0-beta.78": "effect-patch-hash",
  });
});

it("fails closed when a staged dependency is missing from the committed importer", () => {
  assert.throws(
    () =>
      createStagePnpmLock(rootLockfileFixture, {
        dependencySources: [{ importer: "apps/server", names: ["future-provider"] }],
        devDependencySources: [],
      }),
    StagePnpmLockResolutionError,
    "Expected an object at 'importers.apps/server.dependencies.future-provider'",
  );
});

it("rejects extra native dependencies absent from the committed package graph", () => {
  assert.throws(
    () =>
      createStagePnpmLock(rootLockfileFixture, {
        dependencySources: [],
        devDependencySources: [],
        extraDependencies: { "@ff-labs/fff-bin-darwin-x64": "0.9.4" },
      }),
    StagePnpmLockResolutionError,
    "is absent from the committed pnpm lockfile",
  );
});
