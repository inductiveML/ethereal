import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

export interface LoopbackBackendEndpoint {
  readonly port: number;
  readonly bindHost: "127.0.0.1";
  readonly httpBaseUrl: URL;
}

export class DesktopBackendEndpoint extends Context.Service<
  DesktopBackendEndpoint,
  {
    readonly configure: (port: number) => Effect.Effect<LoopbackBackendEndpoint>;
    readonly current: Effect.Effect<LoopbackBackendEndpoint>;
  }
>()("@t3tools/desktop/backend/DesktopBackendEndpoint") {}

export const layer = Layer.effect(
  DesktopBackendEndpoint,
  Effect.gen(function* () {
    const endpointRef = yield* Ref.make<Option.Option<LoopbackBackendEndpoint>>(Option.none());

    const configure = (port: number) => {
      const endpoint: LoopbackBackendEndpoint = {
        port,
        bindHost: "127.0.0.1",
        httpBaseUrl: new URL(`http://127.0.0.1:${port}`),
      };
      return Ref.set(endpointRef, Option.some(endpoint)).pipe(Effect.as(endpoint));
    };

    const current = Ref.get(endpointRef).pipe(
      Effect.map(
        Option.getOrThrowWith(
          () => new Error("Desktop backend endpoint was read before it was configured."),
        ),
      ),
    );

    return DesktopBackendEndpoint.of({ configure, current });
  }),
);
