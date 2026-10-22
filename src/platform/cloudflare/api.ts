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
import { AccessApp, DEV_IDENTITY, isDev, teamDomain } from "./access.ts";
import { d1SqlDatabase } from "./d1.ts";
import { EntityDatabase } from "./database.ts";
import type { AccessVerifier } from "./identity.ts";
import {
  ACCESS_JWT_HEADER,
  principalFromAccess,
  remoteVerifier,
  verifyAccessToken,
} from "./identity.ts";

/** Backfill steps per building index per minute (500 entities each). */
const CRON_BUILD_STEPS = 20;

const props = {
  main: import.meta.url,
  compatibility: { date: "2026-10-04" },
  observability: {
    enabled: true,
    logs: { enabled: true, invocationLogs: true, headSamplingRate: 1, persist: true },
  },
};

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  isDev
    ? // Local dev has no Access, so every request acts as a simulated dev user.
      Effect.succeed({ ...props, dev: { access: { aud: "dev", identity: DEV_IDENTITY } } })
    : // Deployed: behind Cloudflare Access (workers.dev and previews), and the
      // API verifies Access tokens itself for requests from the Website.
      Effect.gen(function* () {
        // NOTE: Worker props are evaluated at cold start too. `access` and
        // `env` are deploy-time metadata, and resolving the Access application
        // at runtime would read deploy settings the Worker doesn't have.
        if (globalThis.__ALCHEMY_RUNTIME__) {
          return props;
        }
        const access = yield* AccessApp;
        return {
          ...props,
          access,
          env: { ACCESS_AUD: access.aud, ACCESS_TEAM_DOMAIN: yield* teamDomain },
        };
      }),
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
    // The env is only populated at runtime; build the verifier (and its key
    // cache) on first use and keep it for the isolate.
    let verifier: Option.Option<AccessVerifier> | undefined;
    const accessVerifier = () => {
      if (verifier === undefined) {
        const teamDomain: unknown = env["ACCESS_TEAM_DOMAIN"];
        const audience: unknown = env["ACCESS_AUD"];
        verifier =
          typeof teamDomain === "string" && typeof audience === "string"
            ? remoteVerifier(teamDomain, audience)
            : Option.none();
      }
      return verifier;
    };
    // Requests straight through Access carry `ctx.access`. Requests from the
    // Website don't (see identity.ts), so verify the Access token it forwards.
    const identity = Layer.effect(
      Identity,
      Effect.gen(function* () {
        const access = yield* Cloudflare.Access.Context;
        if (access !== undefined) {
          const verified = yield* access.getIdentity().pipe(Effect.orElseSucceed(() => undefined));
          return Identity.of({ principal: Option.some(principalFromAccess(verified)) });
        }
        const request = yield* HttpServerRequest.HttpServerRequest;
        const principal = yield* Option.match(accessVerifier(), {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (v) => verifyAccessToken(request.headers[ACCESS_JWT_HEADER], v),
        });
        return Identity.of({ principal });
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
