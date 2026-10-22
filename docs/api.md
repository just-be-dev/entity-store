# Entity store API

Other Workers can also call the store over a service binding: see [RPC](#rpc-over-a-service-binding) and [Change events](#change-events).

All HTTP routes live under `/api` and need a verified principal (Cloudflare Access; see [Cloudflare](cloudflare.md#identity-and-authorization)) except `GET /api/health`. They take and return JSON, and return errors as
`{ "error": string, "code": string, ...details }`. Request bodies are capped at 256 KB.

| Status | `code`                                                                               |
| ------ | ------------------------------------------------------------------------------------ |
| 400    | `BadRequest` (malformed JSON, body doesn't match the route's shape, bad query param) |
| 401    | `Unauthenticated` (no verified principal; every route except `/api/health`)          |
| 404    | `TypeNotFound`, `VersionNotFound`, `EntityNotFound`, `RevisionNotFound`,             |
|        | `IndexNotFound`, `ChangeNotFound`                                                    |
| 409    | `TypeAlreadyExists`, `TypeInUse` (`type`, `reasons`), `EntityAlreadyExists`,         |
|        | `EntityTypeMismatch` (`id`, `type`, `actual`), `VersionConflict`, `RevConflict`      |
|        | (`currentRev`), `EntityLinked` (`linkedFrom`), `IndexAlreadyExists`,                 |
|        | `IndexNotReady` (`state`), `UniqueViolation` (`conflicts`)                           |
| 410    | `EntityDeleted` (`rev` = the delete revision)                                        |
| 413    | `BadRequest` (body too large)                                                        |
| 422    | `InvalidSchema`/`InvalidLens` (`issues`), `LensCheckFailed` (`report`),              |
|        | `ValidationFailed`, `ProjectionFailed`, `LinkTargetInvalid` (`problems`),            |
|        | `InvalidIndex` (`issues`), `IndexKeyFailed`                                          |
| 500    | `StorageFailure`                                                                     |

## Entity types and schema versions

| Method & path                          | Body / query                      | Returns                                 |
| -------------------------------------- | --------------------------------- | --------------------------------------- |
| `GET /api/types`                       |                                   | `{ items: TypeSummary[] }`              |
| `POST /api/types`                      | `{ name, description?, schema }`  | `201 TypeInfo` (version 1)              |
| `GET /api/types/:type`                 |                                   | `TypeInfo` (all versions, oldest first) |
| `DELETE /api/types/:type`              |                                   | `{ name }`                              |
| `GET /api/types/:type/versions/:v`     |                                   | `VersionInfo & { jsonSchema }`          |
| `POST /api/types/:type/versions/check` | `{ schema, lens, samples? }`      | `{ from, to, report: LensReport }`      |
| `POST /api/types/:type/versions`       | `{ schema, lens, note?, force? }` | `201 { version: VersionInfo, report }`  |

```ts
type TypeSummary = { name; description; latestVersion; createdAt; updatedAt };
type TypeInfo = TypeSummary & { versions: VersionInfo[] };
type VersionInfo = { type; version; schema: EntitySchema; lens?: Lens; note; createdAt };
```

`DELETE /api/types/:type` removes the type with its versions, indexes,
deleted entities, and their revisions and changes. It's refused with
`409 TypeInUse` (`reasons`, such as `"it has 3 live entities"` or
`"post's latest schema (v2) links to it"`) while the type has live entities
or another type's latest schema links to it. A type can then be created
again under the same name, starting from v1.

`check` is a dry run: it validates the schema and lens and property-checks the
lens (random old-version documents must lens into valid new documents and vice
versa, and up to 50 stored entities must survive the forward lens).
`POST .../versions` runs the same check and refuses with `LensCheckFailed`
unless `force: true`.

```ts
type LensReport = {
  ok: boolean;
  forward: { checked: number; failures: { input; output?; error }[] };
  backward: { checked: number; failures: { input; output?; error }[] };
  existing: { checked: number; failures: { input; output?; error }[] };
  roundTrip: { checked: number; lossy: number; example?: { input; forward; back } };
  examples: { input; output }[];
  warnings: string[];
};
```

## Entities

| Method & path                       | Body / query                                 | Returns                                                  |
| ----------------------------------- | -------------------------------------------- | -------------------------------------------------------- |
| `GET /api/types/:type/entities`     | `?version&cursor&limit` (≤ 200),             | `{ items: Entity[], failures, nextCursor? }`             |
|                                     | `&index&eq` to look up by key                |                                                          |
| `POST /api/types/:type/entities`    | `{ id?, version?, data, meta? }`             | `201 Entity`                                             |
| `PUT /api/types/:type/entities/:id` | `{ version?, patch, expectedRev?, meta? }`   | `{ entity: Entity, created }` (`201` if created)         |
| `GET /api/entities/:id`             | `?version&rev`                               | `Entity`                                                 |
| `PUT /api/entities/:id`             | `{ version?, data, expectedRev?, meta? }`    | `Entity` (presented at `version`)                        |
| `PATCH /api/entities/:id`           | `{ version?, patch, expectedRev?, meta? }`   | `Entity` (RFC 7386 merge patch, `null` deletes)          |
| `DELETE /api/entities/:id`          | `?expectedRev`, or `{ expectedRev?, meta? }` | `{ id, rev }`                                            |
| `GET /api/entities/:id/backlinks`   | `?cursor&limit`                              | `{ items: Backlink[], nextCursor? }`                     |
| `GET /api/entities/:id/history`     | `?version&before&limit`                      | `{ id, type, items: Revision[], failures, nextBefore? }` |

```ts
type Entity = { id; type; version; storedVersion; rev; data; createdAt; updatedAt };
type Revision = {
  rev;
  op: "create" | "replace" | "patch" | "delete";
  version;
  storedVersion;
  writerVersion;
  data;
  createdAt;
};
```

- `version` on reads picks the schema version to present data in (default: latest).
  On writes it's the version the writer speaks. Omitted, it's the type's
  latest version at the time of the write. Writers that name a version keep
  working after a new one ships: their edits are carried forward without
  clobbering fields they can't see. Responses always carry the `version` used.
- Entity ids match `^[A-Za-z0-9_.@-]{1,128}$`, so `ada@example.com` works.
  Percent-encode them in paths (`/api/entities/ada%40example.com`). The ids
  `.` and `..` match the pattern but can't be addressed in a URL path.
- `meta` is an optional JSON object of at most 1 KB on any write. It's stored
  with the write's change and returned in [change events](#change-events) and
  `getChange`. The store doesn't interpret it.
- `storedVersion` is the version the data is physically stored at.
- Without `expectedRev`, writes retry on a lost race against a fresh read. With
  it, a stale revision fails with `409 RevConflict` and `currentRev`.
- `include=links` adds `included: { [id]: Entity }` with every entity the
  returned data links to, each at its type's latest version.
- `Backlink = { source, type, path }`: an entity linking here and the field
  path (in its stored version) holding the link.
- Writes fail with `422 LinkTargetInvalid` (`problems: { path, target, message }[]`)
  if a new link points at a missing, deleted, or wrong-type entity. `DELETE`
  fails with `409 EntityLinked` (`linkedFrom: Backlink[]`, up to 20) while other
  entities link here.
- `failures` lists entities/revisions whose data couldn't be lensed to the
  requested version, instead of failing the whole page.

### Upsert

`PUT /api/types/:type/entities/:id` with `{ version?, patch, expectedRev?, meta? }`:

- **Missing id:** creates the entity from `patch`, with `null` members
  dropped. Returns `created: true` and `201`.
- **Live entity of `type`:** applies `patch` as an RFC 7386 merge patch
  (`op: "patch"`). Returns `created: false`.
- **Deleted entity of `type`:** recreates it from `patch` alone at the next
  rev (`op: "create"`). Returns `created: true`.
- **Entity of another type, live or deleted:** `409 EntityTypeMismatch`
  (`{ id, type, actual }`).

`expectedRev: 0` means "must be missing or deleted". Any other value must
match the live rev. Either way a mismatch is `409 RevConflict`, with
`currentRev: 0` when there's no live entity. Without `expectedRev`, an
upsert that loses a race retries against a fresh read, like other writes.

## Change events

Every write records one change in the same D1 transaction as its revision,
so a change exists if and only if the write committed.

```ts
type Op = "create" | "replace" | "patch" | "delete";
/** What a queue message carries, and what listChanges lists. */
type ChangeEvent = {
  v: 1;
  seq: number; // commit order, increasing
  type: string;
  id: string;
  rev: number;
  op: Op;
  meta: object | null; // the writer's meta
  createdAt: number;
};
/** `before` is the data at rev - 1 (null at rev 1 or after a delete); `after` is null for a delete. */
type Change = ChangeEvent & { version: number; before: unknown | null; after: unknown | null };
```

| Method & path      | Query                  | Returns                                       |
| ------------------ | ---------------------- | --------------------------------------------- |
| `GET /api/changes` | `?after&limit` (≤ 200) | `{ items: ChangeEvent[], nextAfter? }` by seq |

Changes are also sent to a Cloudflare Queue, `entity-store-<stage>-changes`
(logical ID `Changes`), one `ChangeEvent` per message body. A flusher sends
the changes after a delivery cursor after every write (with `waitUntil`) and
on the API's minutely cron. It advances the cursor only after a send
succeeds, so a failure delays delivery but never skips a change.

- **At least once.** Two flushers can send the same batch, and a retried
  batch can arrive after later ones. Dedupe by `(id, rev)`, and don't rely
  on order.
- **Payloads aren't in the message.** Read them with `getChange(id, rev)`,
  which lenses `before` and `after` to any version. A change whose type was
  deleted since, or written before the change feed existed, is
  `404 ChangeNotFound`. Drop such messages.
- entity-store declares no consumer. Cloudflare allows one consumer Worker
  per queue.

## RPC over a service binding

The API Worker serves the same operations as RPC methods to Workers that hold
a service binding to it. RPC methods can't be reached over HTTP and aren't
behind Access: holding the binding is the authorization. Calls act as
principal `{ _tag: "ServiceBinding", name: "rpc" }`.

The methods are on the Worker's default entrypoint, not a named
`EntityStoreRpc` entrypoint. Alchemy's Effect Workers can't export named
entrypoint classes yet (see `src/rpc/entityStoreRpc.ts`).

Every method takes and returns structured-clone-safe plain JSON and **never
throws for domain errors**. It returns

```ts
type Result<A> =
  | { ok: true; value: A }
  | { ok: false; error: { code: string; message: string; [detail: string]: unknown } };
```

`code` and the details are the same as the HTTP error bodies above.
Arguments that don't decode are `BadRequest`, and unexpected failures are
`StorageFailure`. Writes flush the change feed after they commit, as HTTP
writes do.

| Method                          | Input                                        | Value                                  |
| ------------------------------- | -------------------------------------------- | -------------------------------------- |
| `listTypes()`                   |                                              | `TypeSummary[]`                        |
| `getType(name)`                 |                                              | `TypeInfo` (all versions)              |
| `createType(input)`             | `{ name, description?, schema }`             | `TypeInfo`                             |
| `checkVersion(type, input)`     | `{ schema, lens, samples? }`                 | `{ from, to, report }`                 |
| `createVersion(type, input)`    | `{ schema, lens, note?, force? }`            | `{ version: VersionInfo, report }`     |
| `deleteType(name)`              |                                              | `{ name }`                             |
| `listEntities(type, options?)`  | `{ version?, cursor?, limit?, index?, eq? }` | `EntityPage`                           |
| `getEntity(id, options?)`       | `{ version?, rev? }`                         | `Entity`                               |
| `createEntity(type, input)`     | `{ id?, version?, data, meta? }`             | `Entity`                               |
| `replaceEntity(id, input)`      | `{ version?, data, expectedRev?, meta? }`    | `Entity`                               |
| `patchEntity(id, input)`        | `{ version?, patch, expectedRev?, meta? }`   | `Entity`                               |
| `upsertEntity(type, id, input)` | `{ version?, patch, expectedRev?, meta? }`   | `{ entity, created }`                  |
| `deleteEntity(id, options?)`    | `{ expectedRev?, meta? }`                    | `{ id, rev }`                          |
| `getChange(id, rev, options?)`  | `{ version? }`                               | `Change`                               |
| `listChanges(options?)`         | `{ after?, limit? }` (≤ 200)                 | `{ items: ChangeEvent[], nextAfter? }` |

`EntityPage` is `{ items: Entity[], failures, nextCursor? }`, as over HTTP.

### Consuming from another Alchemy stack

The stack is named `entity-store` and keeps its state in `Cloudflare.state()`
for deployed stages. Another stack in the same Cloudflare account that also
uses `Cloudflare.state()` can reference its resources by logical ID and
stage:

- `Api`: the API Worker, to bind for RPC.
- `Changes`: the queue to consume.

In this sketch, `ChangeEvent` is the type above and `handleChange` is the consumer's own code:

```ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/** entity-store's deployment for this stage (same stage name as this stack). */
const entityStore = (stage: string) => ({ stack: "entity-store", stage });

export default class Automations extends Cloudflare.Worker<Automations>()(
  "Automations",
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const api = yield* Cloudflare.Worker.ref("Api", entityStore(stage));
    return {
      main: import.meta.url,
      // A service binding to the API Worker's default entrypoint.
      env: { ENTITY_STORE: api },
    };
  }),
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const changes = yield* Cloudflare.Queues.Queue.ref("Changes", entityStore(stage));
    const env = yield* Cloudflare.Workers.WorkerEnvironment;
    // Declares this Worker as the queue's consumer. A failed handler retries the whole batch.
    yield* Cloudflare.Queues.consumeQueueMessages<ChangeEvent>(
      changes,
      { batchSize: 10, maxRetries: 5 },
      (messages) =>
        Stream.runForEach(messages, (message) =>
          Effect.tryPromise(() =>
            env.ENTITY_STORE.getChange(message.body.id, message.body.rev),
          ).pipe(Effect.flatMap(handleChange)),
        ),
    );
    return { fetch: /* … */ };
  }).pipe(Effect.provide(Cloudflare.Queues.EventSourceLive)),
) {}
```

- At runtime, `env.ENTITY_STORE.<method>(…)` returns a `Promise<Result<…>>`.
  It rejects only if the call itself fails (for example, the API Worker
  crashed). Domain errors come back as `{ ok: false, error }`.
- The stack also outputs `apiWorkerName` and `changesQueueName`, which you
  can read with `Alchemy.stackRef("entity-store", { stage })`, or copy to
  bind by name.
- Under `alchemy dev`, refs resolve against the consuming stack's own state.
  A consumer using `Alchemy.localState()` can't see entity-store's dev
  resources, so test against stubs, or against a deployed stage you're
  allowed to use. entity-store's local queue accepts and drops messages
  while nothing consumes it.
- This wiring follows Alchemy 2.0.0-beta.83's source. It hasn't been
  deployed across two stacks yet.

## Indexes

| Method & path                               | Body                              | Returns                            |
| ------------------------------------------- | --------------------------------- | ---------------------------------- |
| `GET /api/types/:type/indexes`              |                                   | `{ items: IndexInfo[] }`           |
| `POST /api/types/:type/indexes`             | `{ name, version, key, unique? }` | `201 IndexInfo`                    |
| `GET /api/types/:type/indexes/:name`        |                                   | `IndexInfo`                        |
| `DELETE /api/types/:type/indexes/:name`     |                                   | `{ type, name }`                   |
| `POST /api/types/:type/indexes/:name/build` |                                   | `IndexInfo` (after a backfill run) |

```ts
type IndexInfo = {
  type;
  name;
  version;
  key;
  unique;
  state: "building" | "ready" | "failed";
  error?; // why the backfill failed
  createdAt;
  updatedAt;
};
type UniqueConflict = { index; key; id? }; // id is absent if another writer won a race
```

- `GET /api/types/person/entities?index=email&eq=ada%40example.com` lists
  entities whose key is exactly `eq`, ordered by id, with the usual
  `version`, `cursor`, `limit`, and `include=links`. `index` and `eq` go
  together. `eq=` (empty) is a real key.
- `POST .../indexes` backfills up to 5000 existing entities before it returns.
  Larger types come back `building` and finish in the background. `build`
  runs another bounded batch of steps now.
- A write whose key can't be computed fails with `422 IndexKeyFailed`. A write
  that takes a unique key another entity holds fails with `409 UniqueViolation`.

See [data model](data-model.md#indexes) for key rules, pinning, and costs.

## Authoring helpers (no storage)

| Method & path             | Body                       | Returns                                                    |
| ------------------------- | -------------------------- | ---------------------------------------------------------- |
| `POST /api/schema/check`  | `{ schema }`               | `{ ok, issues: { path, message }[] }`                      |
| `POST /api/lens/run`      | `{ lens, direction, doc }` | `{ ok: true, output }` or `{ ok: false, error \| issues }` |
| `GET /api/lens/functions` |                            | `{ items: { name, doc, minArgs, maxArgs }[] }`             |

See [data model](data-model.md) for the schema and lens languages.
