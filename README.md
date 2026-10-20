# Entity store

A schema-versioned entity store on Cloudflare D1, built with Effect 4, Foldkit, and Alchemy v2 (from the [cafe-stack](https://github.com/just-be-dev/cafe-stack) template).

- **One table for every entity.** Entities of all types live in `entities` as JSON, tagged with their type and the schema version they're stored at.
- **Schemas are data.** Entity types and their schemas are created through the UI or API, as JSON, with no code deploy or migration. They compile to Effect Schema at runtime.
- **Versioned schemas with lenses.** A new schema version carries a lens from the previous one: a list of bidirectional ops (`rename`, `add`, `convert`, `hoist`, `derive`, …) with a small, pure expression language for computed fields. Lenses are data too, authored in the UI.
- **Lenses run at read time.** Data stays at the version it was written in and is lensed to whichever version a reader asks for. Old writers keep working: their edits are translated forward without clobbering fields they can't see.
- **Checked lenses.** Before a version is saved, its lens is property-checked against random documents of both schemas and against stored data, with counterexamples shown in the UI.
- **Links between entities.** A `link` field points at another entity of a given type. Writes check that targets exist, deletes are refused while something links to an entity, and reads can include linked entities or list backlinks.
- **Secondary indexes.** An index is a key expression pinned to one schema version, such as `lower(email)` at v1, optionally unique. Lookups are one index seek. New schema versions never invalidate an index, because keys are computed at the pinned version. Indexes are defined on each type's Indexes page, and the type page can find entities by key.
- **History on every write.** Each write appends a snapshot revision in the same D1 transaction, for 2 rows written per edit, with optimistic concurrency on `rev`.

```sh
mise trust && mise install
mise run check
mise run dev
```

`mise run dev` prints a Website URL with the UI; the API is at `<url>/api/*`. See [docs/api.md](docs/api.md) for routes and [docs/data-model.md](docs/data-model.md) for the storage layout, schema language, lens ops, and expression language.

## Example

```sh
# v1: first and last names
curl -X POST $URL/api/types -d '{"name":"person","schema":{"fields":{
  "firstName":{"type":"string"},"lastName":{"type":"string"}}}}'
curl -X POST $URL/api/types/person/entities -d '{"id":"ada","version":1,
  "data":{"firstName":"Ada","lastName":"Lovelace"}}'

# v2: one name field, plus an optional age. The lens is data.
curl -X POST $URL/api/types/person/versions -d '{
  "schema":{"fields":{"fullName":{"type":"string"},"age":{"type":"number","optional":true}}},
  "lens":{"ops":[
    {"op":"derive",
     "forward":{"fullName":"firstName + \" \" + lastName"},
     "backward":{"firstName":"split(fullName, \" \")[0]",
                 "lastName":"join(slice(split(fullName, \" \"), 1), \" \")"}},
    {"op":"add","field":"age"}]}}'

curl $URL/api/entities/ada            # {"version":2,"storedVersion":1,"data":{"fullName":"Ada Lovelace"}}
curl "$URL/api/entities/ada?version=1" # still readable as v1
curl $URL/api/entities/ada/history
```

The version is saved only if the lens check passes. Had v1 required `minLength: 1` names, the check would reject this lens with a counterexample such as `{"fullName":"x"}` → `{"firstName":"x","lastName":""}`. It also warns that names containing extra spaces don't round-trip exactly.

## Layout

```text
migrations/                       D1 tables: entity_types, schema_versions, entities,
                                  entity_revisions (0001); entity_links + triggers (0002);
                                  entity_indexes, index_entries, index_guard (0003)
src/
  schema/                         schema-as-data model and compiler to Effect Schema
  lens/                           lens ops, expression language, lens property check
  entity/                         EntityStore application, SqlDatabase port, patch/diff
  http/                           routes, body limits, error mapping
  api.ts                          route composition
  testing/                        node:sqlite SqlDatabase for tests
  platform/cloudflare/
    database.ts / d1.ts           D1 declaration and SqlDatabase adapter
    api.ts / stack.ts / edge.ts   API Worker, Alchemy stack, Website forwarding
  ui/                             Foldkit UI
```

## Not done yet

- **All-or-nothing access.** Everyone Cloudflare Access lets in can do everything. There are no per-type or read-only permissions.
- Deletes are soft (tombstone plus a `delete` revision). There's no restore or purge yet.
- Links only restrict deletes; there's no cascade or "unlink on delete" option yet.

## Deploying

Set up a Cloudflare profile with `mise run cloudflare:profile`, or point `ALCHEMY_PROFILE` at an existing one. `mise run deploy` deploys the `prod` stage. The first deploy may offer to create Cloudflare-hosted Alchemy state.

Deploying needs `ACCESS_EMAILS` and `ACCESS_TEAM_DOMAIN` (see below), and the Cloudflare account needs a Zero Trust organization for Access logins.

Both Workers sit behind one Cloudflare Access application, covering custom routes, `workers.dev`, and version preview URLs:

- People in `ACCESS_EMAILS` sign in through Access.
- Automated clients send the `AgentToken` service token's headers: `CF-Access-Client-Id` (the stack's `agentTokenClientId` output) and `CF-Access-Client-Secret` (stored in Alchemy state).

The API answers both on its own workers.dev URL and through the Website's service binding. It accepts a request only with a verified principal:

- **Direct requests:** `ctx.access`, which only Access sets.
- **Through the Website:** the `Cf-Access-Jwt-Assertion` token, which the API verifies (signature, issuer, audience, expiry).

Everything except `/api/health` answers `401 Unauthenticated` without a principal. Local dev creates no Access resources; the API acts as `dev@localhost`.

### Environment variables

Only `ACCESS_EMAILS` and `ACCESS_TEAM_DOMAIN` are required, and only to deploy. Keep them in your shell or a gitignored `.env`; Alchemy loads `.env` automatically. With nothing else set, the stack is named `entity-store`, the app is served from `/`, and there are no custom routes.

| Variable             | Effect                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `ACCESS_EMAILS`      | Comma-separated emails Cloudflare Access lets in. Required to deploy; unused by `alchemy dev`.          |
| `ACCESS_TEAM_DOMAIN` | The Zero Trust team domain, e.g. `team.cloudflareaccess.com`. The API verifies Access tokens it issued. |
| `PROJECT_NAME`       | Names the Alchemy stack. Alchemy keys state and resource names by stack, so give each project its own.  |
| `BASE_PATH`          | Serves the app under a path prefix such as `/<project>/`. It must start and end with `/`.               |
| `STAGE`              | Set to `prod` to enable the route below.                                                                |
| `PROJECT_HOST`       | Host for the prod route, such as `apps.example.com`.                                                    |
| `PROJECT_ZONE`       | Cloudflare zone that owns that host, such as `example.com`.                                             |

When `STAGE=prod` and `PROJECT_NAME`, `PROJECT_HOST`, and `PROJECT_ZONE` are all set, the Website is routed at `<host>/<project>/*`, and the stack returns `https://<host>/<project>/` as its URL.

Under a base path, UI code must build URLs from `import.meta.env.BASE_URL`, not absolute `/` paths.

## Telemetry

Both Workers persist invocation logs and traces with a sampling rate of `1`, so every request is recorded. The API also provides `Cloudflare.Telemetry({ headSamplingRate: 1, persist: true })`, which exports the `Api.request` span and any `Effect.withSpan` or `Effect.fn` spans to Cloudflare.

After a deploy, request `/api/health` and open **Workers & Pages → App / Api → Observability**. Lower the sampling rates in `stack.ts` and `api.ts` once traffic grows. The [Cloudflare guide](docs/cloudflare.md) has the details.

## Docs

| Guide                                     | Covers                                                  |
| ----------------------------------------- | ------------------------------------------------------- |
| [Data model](docs/data-model.md)          | Storage layout, schema language, lenses, write rules    |
| [HTTP API](docs/api.md)                   | Routes, payloads, and error codes                       |
| [Organization](docs/organization.md)      | Where code goes as the project grows                    |
| [Architecture](docs/architecture.md)      | Domains, services and layers, lifetimes, transactions   |
| [Tooling](docs/tooling.md)                | Pinned versions, config files, commands, patches, AI    |
| [Cloudflare](docs/cloudflare.md)          | Alchemy phases, Worker topology, telemetry, state, D1   |
| [Guardrails](docs/guardrails.md)          | Boundaries, security, verification, what needs approval |
| [Agent instructions](AGENTS.md)           | Rules for agents working in this repo                   |
| [UI agent instructions](src/ui/AGENTS.md) | Foldkit architecture, testing, components, upgrades     |
| [Dependency patches](patches/README.md)   | Alchemy and Foldkit DevTools fixes                      |
