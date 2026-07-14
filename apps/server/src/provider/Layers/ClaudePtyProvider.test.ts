import { expect, it } from "vite-plus/test";

import { applyClaudePtyProbe } from "./ClaudePtyProvider.ts";

const base = {
  displayName: "Claude",
  enabled: true,
  installed: true,
  version: "2.1.208",
  status: "warning" as const,
  auth: { status: "unknown" as const },
  checkedAt: "2026-07-14T12:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

it("marks the PTY provider ready only with hook capability and subscription auth", () => {
  expect(
    applyClaudePtyProbe(base, {
      versionOutput: "2.1.208 (Claude Code)",
      helpOutput: "--settings --session-id --resume --name --model --permission-mode --effort",
      authOutput: JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        email: "person@example.com",
        subscriptionType: "max",
      }),
    }),
  ).toMatchObject({
    displayName: "Claude PTY",
    badgeLabel: "Subscription",
    status: "ready",
    auth: {
      status: "authenticated",
      type: "max",
      label: "Claude Max Subscription",
      email: "person@example.com",
    },
  });
});

it("fails the provider capability gate when HTTP approval hooks are unavailable", () => {
  expect(
    applyClaudePtyProbe(base, {
      versionOutput: "1.0.0 (Claude Code)",
      helpOutput: "--session-id --resume --permission-mode",
      authOutput: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
    }),
  ).toMatchObject({
    status: "error",
    auth: { status: "authenticated" },
    message: expect.stringMatching(/HTTP PermissionRequest hooks/),
  });
});
