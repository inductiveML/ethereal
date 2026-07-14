// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv } from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("returns only the supplied base environment for an unconfigured clone", () => {
    const env = loadRepoEnv({
      baseEnv: { PATH: "/usr/local/bin", PROVIDER_API_KEY: "provider-key" },
      repoRoot: makeTemporaryDirectory(),
    });

    expect(env).toEqual({
      PATH: "/usr/local/bin",
      PROVIDER_API_KEY: "provider-key",
    });
  });

  it("merges root, local, and base environments in ascending precedence", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "SHARED_VALUE=root\nROOT_AND_LOCAL=root\nROOT_ONLY=root-only\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "SHARED_VALUE=local\nROOT_AND_LOCAL=local\nLOCAL_ONLY=local-only\n",
    );

    expect(
      loadRepoEnv({
        baseEnv: {
          SHARED_VALUE: "process",
          PROCESS_ONLY: "process-only",
        },
        repoRoot,
      }),
    ).toEqual({
      SHARED_VALUE: "process",
      ROOT_AND_LOCAL: "local",
      ROOT_ONLY: "root-only",
      LOCAL_ONLY: "local-only",
      PROCESS_ONLY: "process-only",
    });
  });

  it("does not translate environment variable names", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(NodePath.join(repoRoot, ".env"), "CANONICAL_VALUE=canonical\n");

    expect(loadRepoEnv({ baseEnv: {}, repoRoot })).toEqual({
      CANONICAL_VALUE: "canonical",
    });
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ethereal-env-"));
  temporaryDirectories.push(directory);
  return directory;
}
