import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AccessApp, AgentToken, isDev } from "./access.ts";
import Api from "./api.ts";
import { hubBindings, hubPaths } from "./hub.ts";
import { ChangesQueue } from "./queue.ts";

/** An optional variable; blank counts as unset. */
const optional = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Config.map(Option.map((value) => value.trim())),
    Config.map(Option.filter((value) => value.length > 0)),
  );

/**
 * Optional deploy settings, read at plan time. With none set, there are no
 * custom routes. With STAGE=prod, PROJECT_HOST and PROJECT_ZONE set, the app
 * is routed at the root of `<host>` on the zone.
 *
 * The projects runner also sets PROJECT_NAME and BASE_PATH. The stack ignores
 * them: each project has its own host, and the stack name keys Alchemy state,
 * so it stays fixed.
 */
export const DeployConfig = Config.all({
  stage: optional("STAGE"),
  host: optional("PROJECT_HOST"),
  zone: optional("PROJECT_ZONE"),
}).pipe(
  Config.map(({ stage, host, zone }) => ({
    prodRoute: Option.all({ host, zone }).pipe(
      Option.filter(() => Option.contains(stage, "prod")),
      Option.map(({ host, zone }) => ({
        routes: [{ pattern: `${host}/*`, zoneName: zone }],
        url: `https://${host}/`,
      })),
    ),
  })),
);

const { prodRoute } = Effect.runSync(DeployConfig);

export const App = Cloudflare.Website.Foldkit("App", {
  main: "src/platform/cloudflare/edge.ts",
  env: { API: Api, ...hubBindings(isDev) },
  // Behind Cloudflare Access when deployed (see access.ts); open in local dev.
  ...(isDev ? {} : { access: AccessApp }),
  assets: { runWorkerFirst: ["/api/*", ...hubPaths] },
  ...Option.match(prodRoute, { onNone: () => ({}), onSome: ({ routes }) => ({ routes }) }),
  compatibility: { date: "2026-10-04" },
  observability: {
    enabled: true,
    logs: { enabled: true, invocationLogs: true, headSamplingRate: 1, persist: true },
    traces: { enabled: true, headSamplingRate: 1, persist: true },
  },
});

export type AppEnv = Cloudflare.InferEnv<typeof App>;

const state = Layer.unwrap(
  Effect.gen(function* () {
    const dev = yield* Alchemy.ALCHEMY_DEV.pipe(Effect.orDie);
    return dev ? Alchemy.localState() : Cloudflare.state();
  }),
);

// The stack name keys Alchemy state and prefixes resource names.
export default Alchemy.Stack(
  "entity-store",
  { providers: Cloudflare.providers(), state },
  Effect.gen(function* () {
    // Declared at the root so other stacks can reference it as "Changes"
    // (see docs/api.md). The Api binds it as a producer.
    const changes = yield* ChangesQueue;
    const api = yield* Api;
    const app = yield* App;
    const url = Option.match(prodRoute, { onNone: () => app.url, onSome: ({ url }) => url });
    // What a consumer stack needs: the Worker to bind for RPC and the queue to consume.
    const consumer = { apiWorkerName: api.workerName, changesQueueName: changes.queueName };
    if (isDev) {
      return { url, ...consumer };
    }
    // The secret stays in state; read it with `alchemy state read`.
    const token = yield* AgentToken;
    return { url, ...consumer, agentTokenClientId: token.clientId };
  }),
);
