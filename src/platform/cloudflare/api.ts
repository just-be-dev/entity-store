import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { apiRoutes } from "../../api.ts";
import { Identity } from "../../auth/identity.ts";
import { EntityStore, VersionCache } from "../../entity/store.ts";
import { AppInfo } from "../../service.ts";
import { AccessApp, DEV_IDENTITY, EdgeSecret, isDev } from "./access.ts";
import { d1SqlDatabase } from "./d1.ts";
import { EntityDatabase } from "./database.ts";
import { forwardedPrincipal } from "./identity.ts";
import { principalFromAccess } from "./principal.ts";

/** Backfill steps per building index per minute (500 entities each). */
const CRON_BUILD_STEPS = 20;

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.url,
    compatibility: { date: "2026-10-04" },
    env: { EDGE_SECRET: EdgeSecret },
    // Deployed: behind Cloudflare Access (both workers.dev and previews).
    // Local dev: no Access, so every request acts as a simulated dev user.
    ...(isDev
      ? { dev: { access: { aud: "dev", identity: DEV_IDENTITY } } }
      : { access: AccessApp }),
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
    const store = EntityStore.layer.pipe(
      Layer.provide(Layer.mergeAll(d1SqlDatabase(d1.raw), Layer.succeed(VersionCache, cache))),
    );
    const env = yield* Cloudflare.Workers.WorkerEnvironment;
    // Requests that came straight through Access carry `ctx.access`. Requests
    // from the Website arrive over its service binding, where the edge
    // forwards the principal Access verified there, with the shared secret.
    const identity = Layer.effect(
      Identity,
      Effect.gen(function* () {
        const access = yield* Cloudflare.Access.Context;
        if (access !== undefined) {
          const verified = yield* access.getIdentity().pipe(Effect.orElseSucceed(() => undefined));
          return Identity.of({ principal: Option.some(principalFromAccess(verified)) });
        }
        const request = yield* HttpServerRequest.HttpServerRequest;
        const secret: unknown = env["EDGE_SECRET"];
        return Identity.of({
          principal: forwardedPrincipal(
            request.headers,
            typeof secret === "string" ? secret : undefined,
          ),
        });
      }),
    );
    const requestServices = Layer.mergeAll(AppInfo.layer("Entity store"), store, identity);
    // Finish backfilling large indexes. Each step is idempotent and commits its
    // own progress, so overlapping or retried runs are safe.
    yield* Cloudflare.Workers.cron("* * * * *", () =>
      Effect.gen(function* () {
        const entities = yield* EntityStore;
        yield* entities.buildPendingIndexes({ steps: CRON_BUILD_STEPS, maxIndexes: 4 });
      }).pipe(Effect.withSpan("Api.buildIndexes"), Effect.provide(store)),
    );
    return {
      fetch: handler.pipe(Effect.withSpan("Api.request"), Effect.provide(requestServices)),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.D1.QueryDatabaseBinding,
        Cloudflare.Workers.CronEventSourceLive,
        Cloudflare.Telemetry({ headSamplingRate: 1, persist: true }),
      ),
    ),
  ),
) {}
