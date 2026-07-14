import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopEnvironmentBootstrapSchema } from "./ipc.ts";

describe("DesktopEnvironmentBootstrapSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopEnvironmentBootstrapSchema);

  it("decodes the local desktop backend bootstrap", () => {
    expect(
      decode({
        id: "primary",
        label: "Local environment",
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
      }),
    ).toEqual({
      id: "primary",
      label: "Local environment",
      httpBaseUrl: "http://127.0.0.1:3773/",
      wsBaseUrl: "ws://127.0.0.1:3773/",
    });
  });
});
