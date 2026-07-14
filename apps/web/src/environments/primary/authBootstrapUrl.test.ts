import { describe, expect, it } from "vite-plus/test";

import { consumeBootstrapCredentialFromUrl } from "./auth";

describe("primary environment access URL", () => {
  it("consumes the one-time token without retaining it in browser history", () => {
    const result = consumeBootstrapCredentialFromUrl(
      "http://127.0.0.1:3773/#token=PAIRCODE&section=projects",
    );

    expect(result).toEqual({
      credential: "PAIRCODE",
      sanitizedUrl: "http://127.0.0.1:3773/#section=projects",
    });
  });

  it("leaves ordinary URLs unchanged", () => {
    const rawUrl = "http://127.0.0.1:3773/projects?sort=recent#section=projects";
    expect(consumeBootstrapCredentialFromUrl(rawUrl)).toEqual({
      credential: null,
      sanitizedUrl: rawUrl,
    });
  });
});
