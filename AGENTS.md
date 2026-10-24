# Entity store

An entity store on Cloudflare D1 where schemas and the lenses between schema versions are data, authored through the UI/API. Built on the Effect / Cloudflare / Foldkit starter. Read `README.md`, `docs/data-model.md`, and `docs/api.md` first.

- `src/schema/`: the JSON schema language and its compiler to Effect Schema.
- `src/lens/`: lens ops, the expression language, and the lens property check.
- `src/entity/`: the `EntityStore` application (types, versions, entities, history), the `SqlDatabase` port, and JSON patch/diff helpers.
- `src/consumers/`: which of the automations app's automations and templates use a type (the `AutomationsDirectory` port, its MCP translation, and the type-delete policy).
- `src/http/`: routes and error mapping; `src/api.ts` composes them with the health route.
- `src/platform/cloudflare/`: D1 declaration (`database.ts`), the D1 `SqlDatabase` adapter (`d1.ts`), the API Worker (`api.ts`), the stack, and the edge.
- `src/testing/`: SQLite (`node:sqlite`) implementation of `SqlDatabase` for tests, using the real migrations.
- `src/ui/`: the Foldkit app.

## Entity store invariants

- Schema versions are immutable and append-only while their type exists. `entity_types.latest_version` only moves forward, and version N+1 always carries a lens from N. Isolates cache compiled versions per type `incarnation`; never update a `schema_versions` row in place. Only `deleteType` removes versions, and a type created again gets a new incarnation and a random starting `indexes_rev`.
- Writers name the schema version they speak, or omit it to write at the latest version as of the write. Never replace a version a writer named.
- Every write to `entities` appends exactly one `entity_revisions` row and exactly one `entity_changes` row in the same D1 batch, and is conditional on the `rev` that was read. Keep all three in one batch. A write the store refuses records no change.
- Change delivery is at least once: advance `change_delivery` only after the queue accepted the batch, and only with a conditional update on the cursor that was read.
- `entity_links` mirrors the `link` fields of each entity's stored data. Change it only in the same batch as the entity write, and keep the 0002 triggers: they are what makes link targets and delete restriction hold under concurrent writes.
- `index_entries` holds each entity's keys in the type's indexes. Change it only in the same batch as the entity write. Every entity write batch starts with the `index_guard` insert at the `indexes_rev` its index definitions were read at. Anything that changes which indexes writers maintain (create, fail, drop) bumps `entity_types.indexes_rev` in the same batch.
- An index is pinned to one schema version, and its keys are computed from data lensed to that version. Never re-key an existing index in place; define a new one and drop the old one.
- The index backfill must stay idempotent and safe to run concurrently: entries are inserted only while the entity is still at the rev that was read and the index is the same generation and still building. Writers write every key of a building index, not just changed ones.
- Reads lens stored data to the requested version and validate the result. Data that doesn't project is reported per item (`failures`), not silently dropped or returned unvalidated.
- Lens expressions run in the API Worker on reads: keep the language pure, deterministic, prototype-safe, and bounded (`STEP_BUDGET`). Don't add I/O, clocks, randomness, or `eval`.
- Changing the meaning of an existing lens op or expression function changes how stored data reads. Add new ops/functions instead.
- Type writes and deletes take `expectedVersion`; check it before the lens check and keep it in the write's batch condition.
- The API binds automations' prod `Api` (`AUTOMATIONS`, `src/platform/cloudflare/automations.ts`) on the `prod` stage only; `alchemy dev` and other stages bind nothing. When automations can't be asked, report `status: "unavailable"` and let the store decide; never present that, or `unchecked` automations, as "no automations use it". Only HTTP `DELETE /api/types/:type` (`src/consumers/application.ts`) refuses types automations uses: the store's and the RPC's `deleteType` never call automations, because automations calls the RPC itself.

## The hub shell

This app carries the platform's hub shell: the platform's one sidebar and the assistant drawer, served by the agents project (`docs/hub-shell.md` there). `src/platform/cloudflare/hub-bindings.ts` binds agents' prod `Api` and `Embed` Workers on deployed stages, `hub.ts` forwards `/_hub/*` to them from the App Worker, `index.html` loads `/_hub/shell.js` with `data-app="entities" data-layout="sidebar"`, and the CSP allows `frame-src 'self'`. The UI draws no sidebar or brand of its own, only the white panel; it tells the shell what to list under Entities by publishing a `HubNav` (`src/ui/hub-nav.ts`, derived by `hubNavOf(model)` and published by the subscription in `src/ui/subscription.ts`). agents also binds this app's `Api` to give the assistant read-only entity tools; keep the RPC's read methods compatible.

- The App Worker forwards `/_hub/api/*` with the email Access admitted, and agents trusts it. The email counts only when the request's `cf-access-jwt-assertion`, verified against the App's `ACCESS_AUD` and the team's keys, names the same person; otherwise it passes null. The App's Access application also admits the AgentToken, so an email header beside it is the client's own. Keep `/_hub/*` behind Access.
- The edge's runtime import graph must not reach Alchemy or `cloudflare:*`: Alchemy bindings go in plan-time modules that only the stack's modules import (`hub-bindings.ts`, `hub-frame.ts`). `hub.test.ts` checks.
- entity-store has no MCP server, so it doesn't implement the platform's `mcp(body, headers)` RPC; the assistant reads entities through the entity-store RPC. (The `@modelcontextprotocol/*` dependencies are peers of `agents`.)
- Deploy agents first when the shell's protocol changes; this app only forwards.

## Framed by the hub

People use this app inside hub.just-be.dev, the platform's one page, which frames it at `/entities/…` (prod) or `/entities@<stage>/…` (a preview) and proxies to the app's own origin with hub prod's Access service token and a signed `x-hub-identity` token (contract: `hub-frame-spike.md` and `hub-frame-rollout.md`, owned by the hub; don't change it here). The in-page shell above is the fallback at the app's own hostname, which now redirects people to the hub. See `docs/cloudflare.md` ("Framed by the hub").

- Every stage, prod and previews, trusts hub prod only (`hub-frame.ts`, typed refs into the `hub` stack's prod state). Never trust a hub preview. Hub prod must exist before any stage plans. The refs are declared only on deployed stages, never under `alchemy dev`.
- Hub prod's `PlatformToken` is admitted by Access but is no one by itself: a framed preview's code may hold its secret. The API acts for the person in `x-hub-identity` only when Access's verified JWT names hub prod's client id and the token verifies for `entities@<stage>` (`hub-identity.ts`, `requestPrincipal` in `identity.ts`); otherwise the request is unauthenticated. The audience uses the hub registry's id (`entities`), not the stack's name. A service token, through Access or the Website, is named only by its verified JWT; a person's own Access identity always wins.
- The App's edge sends a person's top-level page load on its own hostname to the hub (`hub-redirect.ts`, a pure function with tests): never for `/api`, `/mcp*`, `/_hub`, `/.well-known/`, `/cdn-cgi/`, files, or the hub's own requests, and never under `alchemy dev`. Deployed stages run the edge first for everything but `/assets/*` and serve pages from `ASSETS`, adding `public/_headers`' policy when Cloudflare didn't (`assetHeaders` in `edge.ts`; keep the two equal).
- **Base path:** one build serves at `/` on the app's own host and under the hub's base. `index.html` carries `<base href="/" />` (the hub injects its own ahead of it), Vite builds with `base: "./"`, and `src/ui/basePath.ts` reads the base at runtime. Routes see paths without the base (`urlToAppRoute`); every URL the UI hands the browser goes through `withAppBase`: `href()` for routes (links, history pushes, the hub nav) and `apiUrl()` for the API. Never write a root-absolute URL into the page or a request without it. Unlike Desk's, `withBase` always prefixes, because prod's base `/entities/` is also the app's own `/entities/<id>` route: pass it app paths only. Same-origin links outside the base (other apps on the hub) load as documents (`followWithinBase`).
- **Layout:** the UI draws no navigation of its own at any width and has no bottom-fixed controls, so it needs nothing for `html[data-hub-layout="sidebar"|"sheet"]`. If it ever gets a phone nav or a bottom bar, hide the nav under `sidebar`, and key any lane for the shell's floating button on `html[data-hub-layout="sheet"]` as well as `html:has(hub-shell)`, or set `--hub-fab-*`.

## Ownership and scope

- Keep small apps flat under `src/`. As responsibilities emerge, group business code by domain under `src/<domain>/`, keeping models, validation, operations, and capability contracts together.
- Platform-independent HTTP starts in `src/api.ts`. Handlers decode input, call a complete application operation, and encode the response. Move routes into `src/http/` when they need their own modules.
- Cloudflare SDKs, native globals, storage adapters, entry points, identity extraction, bindings, and deployment config go in `src/platform/cloudflare/`. Domain code never imports them.
- Platform imports domain, never the reverse. Keep `src/platform/boundary.test.ts` passing and extend it when adding platform SDKs or aliases.
- UI lives in `src/ui/` and follows its `AGENTS.md`. The `@/` alias maps to `src/ui/`.
- Split by responsibility and lifetime, not line count. Add abstractions at real boundaries. Refactor structure and change behavior in separate steps.
- Keep public schemas, storage keys, callback names and payloads, and replay journal names compatible unless a migration changes them explicitly.

## Effect

- Before writing Effect code, run `mise run effect-solutions list`, then `mise run effect-solutions show <topic>` for the patterns you need. Check examples against the installed Effect 4 APIs.
- Import modules directly, e.g. `import * as Effect from "effect/Effect"`.
- Write new Worker and Durable Object code in Effect. Wrap Promise SDKs at the platform boundary with `Effect.tryPromise` and a typed error.
- Decode HTTP bodies and params, stored values, remote responses, configuration, and model output with Schema. Decide what happens when stored data no longer decodes.
- Model expected failures with `Schema.TaggedError` and name operations with `Effect.fn("Module.operation")`.
- Services describe capabilities; layers build implementations. Capture runtime dependencies at the request or instance lifetime so public operations expose only portable requirements.
- Authorization, write ordering, transactions, and partial-failure policy belong to the application operation. Memory and production adapters share the same business validation.
- Use brands for IDs and discriminated unions for states. For replay, keep execution state separate from the records shown to users.
- Recognize errors crossing Durable Object RPC by their structural fields, not `instanceof`.

## Alchemy v2 and Cloudflare

- Use Alchemy v2's Effect API. `node_modules/alchemy/src` is the final reference; docs start at https://alchemy.run/llms.txt.
- A Worker or Durable Object's outer Effect runs at plan time and cold start: declare and acquire bindings there. Storage, raw bindings, callbacks, and identity are usable only in the returned instance or request handler.
- Never load `cloudflare:*` at module top level on a path imported at plan time.
- The Website edge only forwards requests, headers included. The API Worker is reachable on its workers.dev URL and through the Website's service binding; both paths hit the same routes.
- Both Workers sit behind one Cloudflare Access application (`access.ts`). Keep both enrolled. The API trusts only `ctx.access` or a `Cf-Access-Jwt-Assertion` token it verified (issuer and audience pinned); never trust other identity headers. New routes go through `route()` in `src/http/entities.ts` so they require a principal.
- Keep Workers Observability logs and traces on both Workers, and keep `Cloudflare.Telemetry` on Effect-native hosts so `Effect.withSpan` and `Effect.fn` spans reach Cloudflare. Compatibility dates must be `2026-07-28` or later. Tune sampling for volume, and never attach secrets or payloads to telemetry.
- Callbacks are delivered at least once. Make side effects and scheduled jobs idempotent, and test crash and retry behavior.
- Use checkout-local Alchemy state in dev and Cloudflare-hosted state for deployed stages. Never commit local state or credentials.
- Never edit an applied D1 migration; add the next numbered one.

## Verify before finishing

From the repo root:

```sh
mise run check
```

- Run `mise run build` for UI or build changes. It's a local check, not a deploy.
- Tests use Vitest with imports from `@effect/vitest` next to the code they cover. Use `it.effect` for Effect tests with automatic scoping and test services, `it.live` when real time is required, and plain `it` for synchronous or Promise tests.
- Use memory services for application tests. Native Worker, Durable Object, D1, identity, and AI behavior needs local end-to-end checks with `mise run dev` and the URL it prints.
- Test both sides of boundaries, plus failure, retry, and concurrency cases that would catch a plausible bug. Memory tests don't prove native transactional guarantees.
- UI tests use Foldkit Story and Scene. Render and look at affected visual states before calling visual changes done; DOM and accessibility checks are enough for interaction-only changes.
- For template maintenance, also check the frozen install, doc links, config parsing, native API smoke tests, and publication status. A passing UI build is not a deployment.

## Dependencies and operational safety

- Keep Foldkit, `@foldkit/*`, Vite, and `@effect/platform-*` exactly pinned. Upgrade compatible versions together and refresh the UI conventions from the installed Foldkit tag.
- Patch dependencies only with `mise run patch` and `mise run patch:commit`, and document the symptom, cause, fix, and removal criteria in `patches/README.md`. Recheck patches on every upgrade.
- Never commit secrets, tokens, `.env` files, `.alchemy/`, `.wrangler/`, `node_modules/`, or build output. `private: true` blocks npm publishing; GitHub visibility is set separately.
- When the user shares a local URL, start with read-only API calls. Mutating requests, AI prompts, job starts, and migrations can change data or cost money.
- Get explicit approval before deploying or destroying, running dev against a deployed stage, migrating shared databases, restarting production, changing access controls, pushing, publishing, or opening or merging PRs. Local disposable tests are fine.
- Preserve existing user work. Report exactly what was verified and whether the work is local, committed, pushed, or deployed.
