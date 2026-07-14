import { assert, describe, it } from "vite-plus/test";

import { makeSmokeEnvironment } from "./smoke-test-env.mjs";

describe("desktop smoke environment", () => {
  it("removes an ambient development server URL for production startup", () => {
    const environment = makeSmokeEnvironment({
      PATH: "/usr/bin",
      VITE_DEV_SERVER_URL: "http://127.0.0.1:5733",
    });

    assert.equal(environment.PATH, "/usr/bin");
    assert.equal(environment.ELECTRON_ENABLE_LOGGING, "1");
    assert.notProperty(environment, "VITE_DEV_SERVER_URL");
  });
});
