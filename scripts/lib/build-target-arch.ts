import { HostProcessArchitecture } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

export type BuildArch = "arm64" | "x64";

export const getDefaultBuildArch = Effect.fn("getDefaultBuildArch")(function* () {
  const processArch = yield* HostProcessArchitecture;
  return processArch === "arm64" ? "arm64" : "x64";
});
