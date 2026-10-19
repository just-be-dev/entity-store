import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { apiRoutes } from "../../api.ts";
import { EntityStore, VersionCache } from "../../entity/store.ts";
import { AppInfo } from "../../service.ts";
import { d1SqlDatabase } from "./d1.ts";
import { EntityDatabase } from "./database.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.url,
    compatibility: { date: "2026-10-04" },
    observability: {
      enabled: true,
      logs: { enabled: true, invocationLogs: true, headSamplingRate: 1, persist: true },
    },
  },
  Effect.gen(function* () {
    const database = yield* EntityDatabase;
    const d1 = yield* Cloudflare.D1.QueryDatabase(database);
    // Compiled schema versions are immutable, so one cache serves the whole isolate.
    const cache = VersionCache.make();
    const handler = yield* HttpRouter.toHttpEffect(apiRoutes);
    const requestServices = Layer.mergeAll(
      AppInfo.layer("Entity store"),
      EntityStore.layer.pipe(
        Layer.provide(Layer.mergeAll(d1SqlDatabase(d1.raw), Layer.succeed(VersionCache, cache))),
      ),
    );
    return {
      fetch: handler.pipe(Effect.withSpan("Api.request"), Effect.provide(requestServices)),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.D1.QueryDatabaseBinding,
        Cloudflare.Telemetry({ headSamplingRate: 1, persist: true }),
      ),
    ),
  ),
) {}
