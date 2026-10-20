import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { testAppLayer, testUser } from "./testing/app.ts";
import { apiRoutes } from "./api.ts";

it.effect("health reads the supplied capability and unknown routes return JSON errors", () =>
  Effect.gen(function* () {
    const { handler } = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          apiRoutes.pipe(Layer.provideMerge(testAppLayer("Different project"))),
          { disableLogger: true },
        ),
      ),
      ({ dispose }) => Effect.promise(dispose),
    );
    const health = yield* Effect.promise(() => handler(new Request("http://app/api/health")));
    expect(health.status).toBe(200);
    expect(yield* Effect.promise(() => health.text())).toBe(
      JSON.stringify({ name: "Different project", status: "ok" }),
    );
    expect(health.headers.get("cache-control")).toBe("no-store");
    const missing = yield* Effect.promise(() => handler(new Request("http://app/api/missing")));
    expect(missing.status).toBe(404);
    expect(yield* Effect.promise(() => missing.text())).toBe(
      JSON.stringify({ error: "Not found" }),
    );
  }),
);

it.effect("entity routes need a verified principal; health doesn't", () =>
  Effect.gen(function* () {
    const { handler } = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          apiRoutes.pipe(Layer.provideMerge(testAppLayer("Entity store", Option.none()))),
          { disableLogger: true },
        ),
      ),
      ({ dispose }) => Effect.promise(dispose),
    );
    const call = (path: string, init?: RequestInit) =>
      Effect.promise(async () => {
        const response = await handler(new Request(`http://app${path}`, init));
        return { status: response.status, body: (await response.json()) as any };
      });
    expect((yield* call("/api/health")).status).toBe(200);
    for (const [path, init] of [
      ["/api/types", undefined],
      ["/api/types/person/entities?index=email&eq=a", undefined],
      ["/api/lens/functions", undefined],
      [
        "/api/types",
        { method: "POST", body: JSON.stringify({ name: "x", schema: { fields: {} } }) },
      ],
    ] as const) {
      const response = yield* call(path, init);
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ code: "Unauthenticated" });
    }
  }),
);

it.effect("a signed-in principal reaches the entity routes", () =>
  Effect.gen(function* () {
    const { handler } = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          apiRoutes.pipe(Layer.provideMerge(testAppLayer("Entity store", Option.some(testUser)))),
          { disableLogger: true },
        ),
      ),
      ({ dispose }) => Effect.promise(dispose),
    );
    const types = yield* Effect.promise(() => handler(new Request("http://app/api/types")));
    expect(types.status).toBe(200);
  }),
);
