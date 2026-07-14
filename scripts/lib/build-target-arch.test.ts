import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HostProcessArchitecture } from "@t3tools/shared/hostProcess";

import { getDefaultBuildArch } from "./build-target-arch.ts";

describe("build-target-arch", () => {
  it.effect("uses arm64 on Apple Silicon", () =>
    Effect.gen(function* () {
      const arch = yield* getDefaultBuildArch().pipe(
        Effect.provide(Layer.succeed(HostProcessArchitecture, "arm64")),
      );

      assert.equal(arch, "arm64");
    }),
  );

  it.effect("uses x64 for other host architectures", () =>
    Effect.gen(function* () {
      const arch = yield* getDefaultBuildArch().pipe(
        Effect.provide(Layer.succeed(HostProcessArchitecture, "x64")),
      );

      assert.equal(arch, "x64");
    }),
  );
});
