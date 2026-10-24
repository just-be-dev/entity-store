import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { DeployConfig, runWorkerFirst } from "./stack.ts";

const read = (env: Record<string, string>) => DeployConfig.parse(ConfigProvider.fromUnknown(env));

const platform = {
  PROJECT_NAME: "cafe",
  BASE_PATH: "/cafe/",
  PROJECT_HOST: "cafe.example.com",
  PROJECT_ZONE: "example.com",
};

it.effect("has no route with nothing set", () =>
  Effect.gen(function* () {
    const settings = yield* read({});
    expect(Option.isNone(settings.prodRoute)).toBe(true);
  }),
);

it.effect("routes prod at the root of the project host, ignoring BASE_PATH", () =>
  Effect.gen(function* () {
    const settings = yield* read({ ...platform, STAGE: "prod" });
    expect(settings.prodRoute).toEqual(
      Option.some({
        routes: [{ pattern: "cafe.example.com/*", zoneName: "example.com" }],
        url: "https://cafe.example.com/",
      }),
    );
  }),
);

it.effect("skips the route for previews and when the host or zone is missing or blank", () =>
  Effect.gen(function* () {
    const preview = yield* read({ ...platform, STAGE: "b-feature-1a2b" });
    expect(Option.isNone(preview.prodRoute)).toBe(true);
    const { PROJECT_ZONE: _, ...noZone } = platform;
    const missing = yield* read({ ...noZone, STAGE: "prod" });
    expect(Option.isNone(missing.prodRoute)).toBe(true);
    const blank = yield* read({ ...platform, PROJECT_HOST: "  ", STAGE: "prod" });
    expect(Option.isNone(blank.prodRoute)).toBe(true);
  }),
);

it("runs the edge first for pages on deployed stages only, never for the hashed build", () => {
  expect(runWorkerFirst(false)).toEqual(["/*", "!/assets/*"]);
  expect(runWorkerFirst(true)).toEqual(["/api/*", "/_hub", "/_hub/*"]);
});
