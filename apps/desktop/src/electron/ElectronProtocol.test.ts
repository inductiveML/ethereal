import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const { handleMock, netFetchMock, registerSchemesAsPrivilegedMock, unhandleMock } = vi.hoisted(
  () => ({
    handleMock: vi.fn(),
    netFetchMock: vi.fn(),
    registerSchemesAsPrivilegedMock: vi.fn(),
    unhandleMock: vi.fn(),
  }),
);

vi.mock("electron", () => ({
  net: { fetch: netFetchMock },
  protocol: {
    handle: handleMock,
    registerSchemesAsPrivileged: registerSchemesAsPrivilegedMock,
    unhandle: unhandleMock,
  },
}));

import * as ElectronProtocol from "./ElectronProtocol.ts";

const registrationInput = {
  scheme: "t3code-dev",
  targetOrigin: new URL("http://127.0.0.1:3773/"),
  backendOrigin: new URL("http://127.0.0.1:3774/"),
} satisfies ElectronProtocol.DesktopProtocolRegistrationInput;

describe("ElectronProtocol", () => {
  beforeEach(() => {
    handleMock.mockReset();
    netFetchMock.mockReset();
    registerSchemesAsPrivilegedMock.mockReset();
    unhandleMock.mockReset();
  });

  it("registers both desktop schemes as standard secure origins", () => {
    ElectronProtocol.registerDesktopSchemesAsPrivileged();

    assert.deepEqual(registerSchemesAsPrivilegedMock.mock.calls[0]?.[0], [
      {
        scheme: "t3code",
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          corsEnabled: true,
          stream: true,
        },
      },
      {
        scheme: "t3code-dev",
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          corsEnabled: true,
          stream: true,
        },
      },
    ]);
  });

  it.effect("proxies the stable internal origin to the local app server", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock.mockResolvedValue(new Response("ok"));

      yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol(registrationInput);
          const response = yield* Effect.promise(() =>
            handler!(new Request("t3code-dev://app/api/health?verbose=1")),
          );
          assert.equal(yield* Effect.promise(() => response.text()), "ok");
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "script-src 'self' 'unsafe-inline'",
          );
          assert.notInclude(
            response.headers.get("content-security-policy") ?? "",
            "challenges.cloudflare.com",
          );
        }),
      );

      assert.deepEqual(
        handleMock.mock.calls.map((call) => call[0]),
        ["t3code-dev"],
      );
      assert.equal(netFetchMock.mock.calls[0]?.[0], "http://127.0.0.1:3773/api/health?verbose=1");
      assert.deepEqual(unhandleMock.mock.calls, [["t3code-dev"]]);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("rejects protocol requests for another host", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol(registrationInput);
          return yield* Effect.promise(() => handler!(new Request("t3code-dev://other/")));
        }),
      );
      assert.equal(response.status, 404);
      assert.equal(netFetchMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("retries transient renderer target failures", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValueOnce(new Response("ready"));
      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol(registrationInput);
          return yield* Effect.promise(() => handler!(new Request("t3code-dev://app/")));
        }),
      );
      assert.equal(yield* Effect.promise(() => response.text()), "ready");
      assert.equal(netFetchMock.mock.calls.length, 2);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("preserves registration failures", () =>
    Effect.gen(function* () {
      const cause = new Error("protocol registration failed");
      handleMock.mockImplementationOnce(() => {
        throw cause;
      });
      const protocol = yield* ElectronProtocol.ElectronProtocol;
      const error = yield* Effect.scoped(protocol.registerDesktopProtocol(registrationInput)).pipe(
        Effect.flip,
      );
      assert.instanceOf(error, ElectronProtocol.ElectronProtocolRegistrationError);
      assert.equal(error.scheme, "t3code-dev");
      assert.strictEqual(error.cause, cause);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("preserves unregistration failures", () =>
    Effect.gen(function* () {
      const cause = new Error("protocol unregistration failed");
      unhandleMock.mockImplementationOnce(() => {
        throw cause;
      });
      const protocol = yield* ElectronProtocol.ElectronProtocol;
      const exit = yield* Effect.exit(
        Effect.scoped(protocol.registerDesktopProtocol(registrationInput)),
      );
      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronProtocol.ElectronProtocolUnregistrationError);
      }
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it("preserves compatible internal schemes and omits hosted authentication origins", () => {
    assert.equal(ElectronProtocol.getDesktopScheme(false), "t3code");
    assert.equal(ElectronProtocol.getDesktopScheme(true), "t3code-dev");
    const policy = ElectronProtocol.makeDesktopContentSecurityPolicy(registrationInput);
    assert.notInclude(policy, "clerk");
    assert.notInclude(policy, "cloudflare");
    assert.include(policy, "img-src 'self' t3code-dev:");
  });
});
