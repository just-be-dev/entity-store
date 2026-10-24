# Cloudflare

Infrastructure is declared with Alchemy v2. The stack is an Effect program in `src/platform/cloudflare/stack.ts`, and `alchemy.run.ts` re-exports it.

## Topology

```text
Browser ── hub.just-be.dev/entities[@stage]/… (the hub frames the app, with its service token)
          │
          ▼
Website (Cloudflare.Website.Foldkit) ── /assets/* (hashed build)
          │ every other path, runWorkerFirst (deployed)
          ▼
edge.ts ── service binding ── Api Worker ◀── direct client (workers.dev)
   │
   ├── page load on its own hostname ── 302 to the hub (hub-redirect.ts)
   ├── other pages ── ASSETS (the built UI)
   └── /_hub/* ── agents' prod Embed and Api Workers (hub shell, hub.ts)
                                   │  ▲
                                   │  └── RPC from other stacks' Workers (service binding)
                                   ├── domain services
                                   ├── D1 (EntityDb)
                                   ├── AUTOMATIONS ──▶ automations' prod Api (prod stage only)
                                   └── Changes queue ──▶ consumer in another stack
```

The Website is a `Cloudflare.Website.Foldkit` with `env: { API: Api, HUB_API, HUB_EMBED, ACCESS_AUD, ACCESS_TEAM_DOMAIN, HUB_CLIENT_ID, HUB_FRAME_PREFIX }`. On deployed stages `assets.runWorkerFirst` is `["/*", "!/assets/*"]`, so the edge sees every path but the hashed build files; under `alchemy dev` it is `["/api/*", "/_hub", "/_hub/*"]` and Vite serves the pages. The API is a `Cloudflare.Worker` that keeps Alchemy's default `workersDev: true`, which gives it a stable workers.dev URL and per-version preview URLs. `edge.ts` declares the env it reads (`EdgeEnv`, checked against `Cloudflare.InferEnv<typeof App>` in `hub.test.ts`) and only forwards requests: `/_hub/*` to agents (`hub.ts`), `/api/*` to the API binding, a person's page load to the hub (below), and everything else to the Website's `ASSETS`. Routing and business logic live in the API.

The edge is bundled from `edge.ts`, so nothing it imports at runtime may load Alchemy or `cloudflare:*`. Agents' Worker refs live in `hub-bindings.ts`, and hub prod's refs in `hub-frame.ts`; only the stack's modules import them.

### Framed by the hub

hub.just-be.dev is the platform's one page: it holds the sidebar and the assistant, and shows this app in an iframe at `/entities/…` (prod) or `/entities@<stage>/…` (a preview), proxying each request to the app's own origin with hub prod's Access service token (`PlatformToken`) and a short-lived identity token (`x-hub-identity`) naming the person. The contract is the hub's (`hub-frame-spike.md`, `hub-frame-rollout.md`); this app's side:

- **Every stage trusts hub prod**, by typed ref into the `hub` stack's prod state (`hub-frame.ts`): the Access application admits its `PlatformToken`, and the API binds `HUB_CLIENT_ID` (the token's client id), `HUB_PUBLIC_KEY` (its `IdentityKey`'s public key) and `HUB_AUDIENCE` (`entities@<stage>`, the hub registry's id, not the stack's). `alchemy dev` binds none of them. Hub prod must exist before a stage plans.
- **Identity:** see [Identity and authorization](#identity-and-authorization). The hub's token is no one by itself.
- **Redirect:** a person's top-level page load on the app's own hostname (`GET`/`HEAD`, `Sec-Fetch-Dest: document`, `Sec-Fetch-Mode: navigate`) is sent with a `302` to the same path and query on the hub, under `HUB_FRAME_PREFIX` (`/entities` or `/entities@<stage>`) (`hub-redirect.ts`). Never for `/api`, `/mcp*`, `/_hub`, `/.well-known/`, `/cdn-cgi/`, files with an extension outside `/types/` and `/entities/` (whose names and ids may hold dots), or a request whose Access JWT names hub prod's client id. Nothing redirects under `alchemy dev`.
- **Headers:** Cloudflare doesn't promise `_headers` on responses the Worker returns from `ASSETS`, so the edge adds any of its headers that are missing (`assetHeaders` in `edge.ts`, kept equal to `public/_headers` by `edge.test.ts`). The hub appends `frame-ancestors 'self'` when it frames the app; the app's own CSP doesn't set one.
- **Base path:** the UI runs under the base the hub injects; see `src/ui/basePath.ts` and the root `AGENTS.md`.

On deployed stages the edge forwards `/_hub/api/*` to agents' `platformFetch` with the person Access admitted: the email in the request's `Cf-Access-Jwt-Assertion`, verified like the API does (below) with the App's own `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN`, when the `Cf-Access-Authenticated-User-Email` header names the same person. A service token's JWT names no one, so the AgentToken with a forged email header is forwarded as no one, and agents refuses it.

Both Workers are behind Cloudflare Access when deployed (`access.ts`). The API checks identity on every request, since requests can arrive directly or through the Website.

The API binds the `Changes` queue (`src/platform/cloudflare/queue.ts`,
named `entity-store-<stage>-changes`) as a producer, and returns the
`EntityStoreRpc` methods next to `fetch`. Both are declared for other stacks
to use (see [API](api.md#consuming-from-another-alchemy-stack)). The stack
outputs `apiWorkerName` and `changesQueueName`.

On the `prod` stage only, the API also binds the `automations` stack's prod
`Api` Worker as a raw service binding, `AUTOMATIONS`
(`src/platform/cloudflare/automations.ts`), to ask which automations and
templates use a type (see [API](api.md#automations-that-use-a-type)). The
stage is Alchemy's (`--stage prod`, as `mise run deploy` passes), read at plan
time. Automations runs only against entity-store's prod, and a ref to a stage
automations doesn't have would fail the deploy, so `alchemy dev` and other
stages bind nothing and report automations as not connected. Each call is
`stub.mcp(body, {})`, made as a member call, with a 4-second timeout; a
rejection, a timeout, or Alchemy's `~alchemy/rpc/error` envelope makes
automations unavailable for that request rather than failing it. Spans are
`Automations.mcp`, `AutomationsMcp.callTool`, and `AutomationsDirectory.usage`,
with no payloads.

Both Workers use compatibility date `2026-10-04`. When you move it, test the new date rather than relying on Cloudflare's default.

## Telemetry

`stack.ts` turns on persisted invocation logs and traces for the Website. `api.ts` turns on persisted invocation logs and provides `Cloudflare.Telemetry({ headSamplingRate: 1, persist: true })` on the Worker's outer Effect. That layer adds the API's trace configuration at plan time and builds a fresh tracer for each invocation. Keep it on the Worker host, not on domain services or a runtime shared across requests.

`observability.traces` on its own records Cloudflare's platform spans. The Telemetry layer adds `Api.request` and any `Effect.withSpan` or `Effect.fn` spans to the same waterfall, next to platform operations like fetch and D1. It needs a compatibility date of `2026-07-28` or later. Don't set `observability.traces` explicitly on the API; an explicit setting overrides what the layer contributes.

Sampling is `1` (every request) with dashboard persistence. When traffic grows, tune the Website's logs and traces, the API's logs, and the API's Telemetry layer together.

To check it after a deploy, request `/api/health` and open each Worker under **Workers & Pages → Observability**. You should see an API invocation with an `Api.request` span. Requests served entirely from static assets skip the edge handler. Native tracing forwards scalar span attributes and completion status; span events, links, and structured attributes are dropped.

Keep secrets, auth headers, request and response bodies, and entity data out of logs and spans. Use stable operation names and harmless attributes. Check what request metadata Cloudflare collects and how long it keeps it before you handle personal data.

## Plan time and runtime

Worker and Durable Object declarations run in two phases:

| Phase                                | Use it for                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Outer Effect: plan time / cold start | Declaring bindings and namespaces, choosing resources, building layers                              |
| Returned handler / instance Effect   | Storage operations, raw AI binding calls, durable callbacks, request headers, runtime-bound methods |

Plan time runs under Bun and imports everything reachable from `alchemy.run.ts`. A module that loads `cloudflare:*` at the top level breaks that, so acquire native capabilities inside the runtime phase.

A D1 adapter can grab its database binding in the outer Effect and return a layer that requires `Alchemy.RuntimeContext`. Provide that layer per request or per instance, where the context exists. The service methods capture the context, so callers get a portable capability.

## Local and deployed state

`alchemy dev` uses stage `dev_$USER` with local Workers, Durable Object, and D1 data. `stack.ts` picks `Alchemy.localState()` in dev and `Cloudflare.state()` for deployed stages based on `Alchemy.ALCHEMY_DEV`. Local resource state has to sit next to the checkout's local database. If it were shared, a fresh worktree's empty database could be marked as already migrated.

Run `mise run dev` from the repo root and use the Website URL it prints; the port isn't fixed. Workers AI calls are real remote requests even in local dev and need credentials.

To deploy, add a Cloudflare profile with `mise run cloudflare:profile` or select one with `ALCHEMY_PROFILE`. The first deploy may offer to create Alchemy's Cloudflare-hosted state store. That changes shared infrastructure, so get approval first.

## Deploy settings

`stack.ts` reads optional environment variables at plan time with Effect `Config`. The [README](../README.md#environment-variables) lists them. The app is always served from `/` on its own host: the stack ignores the runner's `BASE_PATH`, because each project gets its own host. The hub serves the same build under `/entities/`, which the UI reads at runtime from `<base>`.

## Identity and authorization

Cloudflare Access authenticates. One shared Access application (`src/platform/cloudflare/access.ts`) gates both Workers on every entry point, with three policies:

- an `allow` policy for members of the Cloudflare account (`cloudflareAccountMember`), which Access checks itself;
- a `non_identity` policy for the `AgentToken` service token;
- a `non_identity` policy for hub prod's `PlatformToken` (`hub-frame.ts`), with which the hub proxies the framed app.

The API turns each request's verified principal into the request-scoped `Identity` service (`src/auth/identity.ts`):

- **Direct requests:** `Cloudflare.Access.Context`, which only Access populates, names a person by its identity's email. A service token straight through Access is named by its verified `Cf-Access-Jwt-Assertion` (below), like one through the Website; without one that verifies, it's no one.
- **Through the Website's service binding:** there's no `ctx.access`, and the Website's own script doesn't get one either, because the static assets router sits in front of it. The edge forwards every header unchanged, including the `Cf-Access-Jwt-Assertion` token Access adds to every request it admits. The API verifies that token with `jose`:
  - RS256 against the team's published keys, cached per isolate;
  - issuer pinned to the account's team domain (looked up at plan time and bound as `ACCESS_TEAM_DOMAIN`);
  - audience pinned to the Access application's AUD, bound as `ACCESS_AUD`;
  - expiry enforced.
- **The hub:** a JWT that verifies and names hub prod's client id (`HUB_CLIENT_ID`) is never a principal itself, since a framed preview's code may hold the token's secret. The request acts as the person in its `x-hub-identity` token, verified by `hub-identity.ts` (ES256 with `HUB_PUBLIC_KEY`, `kid` derived from it, issuer `https://hub.just-be.dev`, audience exactly `HUB_AUDIENCE`, `email === sub`, at most five minutes' life, a minute's skew), or as no one. The identity header counts beside no other credential, and a person's own Access identity always wins (`requestPrincipal` in `identity.ts`).
- **RPC over a service binding:** RPC methods can't be called over HTTP, so
  only a Worker holding a binding to the API reaches them. Each call acts as
  `{ _tag: "ServiceBinding", name: "rpc" }`. Don't bind the API into Workers
  that shouldn't have full access.
- **Anything else is unauthenticated.**

Every route except `/api/health` requires a principal (`src/http/auth.ts`) and answers `401` without one.

Authorization is all-or-nothing for now: Access is the allowlist. When roles or per-type permissions arrive, check them inside the application operations, using `Identity`.

Under `alchemy dev` no Access resources are created. The API's `dev.access` stub makes every request act as `dev@localhost`.

Rotate the agent token by bumping `clientSecretVersion` on `AgentToken`, then redeploying. The hub rotates its own token and key (`hub-frame-spike.md` §9); a new hub key means redeploying this app so it binds the new public key. Access rotates its signing keys itself; the API refetches them as needed.

`public/_headers` sets the CSP for static assets. Set security headers for API responses in the API itself. Keep the deployed CSP strict even if the dev server needs something looser.

## Adding persistence and durable work

- D1: declare `Cloudflare.D1.Database` with `migrations: "./migrations"`. Alchemy tracks applied migrations by hash in `__alchemy_migrations`, so add new numbered files and leave applied ones alone.
- Durable Objects: use them for instance-local storage, coordination, or durable callbacks. Keep the host class thin and call into domain code.
- `Alchemy.makeCallback` delivers at least once. Callback names and payloads, schedule keys, storage keys, and replay journal names all become stored contracts. Make callbacks idempotent before shipping.
- If a state write and a schedule must be atomic, expose one host capability that owns that transaction and test it on the native implementation. Separate D1 and Durable Object stores can't share a transaction.
- Deterministic replay rebuilds working values from its journal. Network calls go in journaled Activities.

## References

- [Alchemy documentation index](https://alchemy.run/llms.txt). Append `.md` to any docs page URL for Markdown.
- `node_modules/alchemy/src`, the final word on the installed version.
- [Cloudflare Workers](https://developers.cloudflare.com/workers/), [Workers Observability](https://developers.cloudflare.com/workers/observability/), [Durable Objects](https://developers.cloudflare.com/durable-objects/), and [D1](https://developers.cloudflare.com/d1/).
