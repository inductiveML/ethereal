import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

describe("deriveProviderInstanceConfigMap", () => {
  it("drops legacy Cursor and Grok instances while preserving supported and unknown drivers", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("cursor")]: {
          driver: ProviderDriverKind.make("cursor"),
          config: {},
        },
        [ProviderInstanceId.make("grok")]: {
          driver: ProviderDriverKind.make("grok"),
          config: {},
        },
        [ProviderInstanceId.make("opencode")]: {
          driver: ProviderDriverKind.make("opencode"),
          config: {},
        },
        [ProviderInstanceId.make("future-provider")]: {
          driver: ProviderDriverKind.make("future-provider"),
          config: {},
        },
      },
    };

    const result = deriveProviderInstanceConfigMap(settings);

    expect(result[ProviderInstanceId.make("cursor")]).toBeUndefined();
    expect(result[ProviderInstanceId.make("grok")]).toBeUndefined();
    expect(result[ProviderInstanceId.make("opencode")]).toBeDefined();
    expect(result[ProviderInstanceId.make("future-provider")]).toBeDefined();
  });
});
