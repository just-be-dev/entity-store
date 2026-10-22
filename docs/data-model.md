# Data model

## Storage layout (D1)

Four core tables, defined in `migrations/0001_entity_store.sql`. Links
(`0002`), secondary indexes (`0003`), and the change feed (`0004`) add their
own, described below.

| Table              | Key                | Holds                                                                    |
| ------------------ | ------------------ | ------------------------------------------------------------------------ |
| `entity_types`     | `name`             | description and `latest_version`                                         |
| `schema_versions`  | `(type, version)`  | immutable schema JSON, plus the lens from `version - 1`                  |
| `entities`         | `id`               | every entity of every type: `type`, stored `version`, `rev`, `data` JSON |
| `entity_revisions` | `(entity_id, rev)` | append-only snapshot per write: `op`, stored and writer version          |

All entities share one table; `data` is JSON and its shape is defined by the
schema version in the row's `version` column. The tables are `WITHOUT ROWID`,
so primary-key lookups touch one b-tree and history for an entity is one
contiguous range scan.

Cost per operation, in D1 rows:

| Operation               | Round trips      | Rows read             | Rows written                           |
| ----------------------- | ---------------- | --------------------- | -------------------------------------- |
| read entity             | 1                | 2 (entity + its type) | 0                                      |
| create                  | 1 batch          | 2                     | 5 (entity, type index entry, revision, |
|                         |                  |                       | change, change index entry)            |
| update / patch / delete | 1 read + 1 batch | 4                     | 4 (entity, revision, change, change    |
|                         |                  |                       | index entry)                           |
| history page            | 1                | n + 2                 | 0                                      |

The batch is a D1 transaction. The revision row is copied from the entity row
inside that transaction (`INSERT … SELECT`), so history can't drift from what
was committed, and the update is conditional on the revision read
(`WHERE rev = ?`), which gives optimistic concurrency without locks. Updates
don't touch the `(type, id)` index because neither column changes.

Schema versions are immutable, so each Worker isolate caches compiled schemas
and lenses after first use; steady-state reads cost no extra queries for
schemas. Every write batch also reads its type's row once, through
`index_guard` (see [Indexes](#indexes)).

## Entity ids and titles

Entity ids match `^[A-Za-z0-9_.@-]{1,128}$` and aren't only dots, so an
email address can be an id. Ids are global across types, and `link` fields hold them.

A schema's root may name a `title`: a top-level field of type `string` or
`nullable` of `string` that is the entity's display name. The UI shows it
where it shows entities. It doesn't change what data is valid.

```json
{ "title": "name", "fields": { "name": { "type": "string" } } }
```

## Change feed

`entity_changes` (`0004`) holds one row per committed write: `seq`
(autoincrement), `entity_id`, `type`, `rev`, `op`, the writer's `meta`, and
`created_at`. The row is inserted in the same batch as the write's revision,
so a change is recorded if and only if the write commits. Writes the store
refuses, or deletes of already-deleted entities, record nothing.

D1 runs one write transaction at a time, so `seq` order is commit order. A
change never commits with a lower `seq` than one already committed, and a
reader that has seen everything up to some `seq` won't miss a later commit
below it.

Delivery to the `Changes` queue uses a cursor in `change_delivery`
(`name = 'queue'`, `after_seq`):

1. Read up to 100 changes after the cursor, in the same query as the cursor.
2. `sendBatch` them.
3. `UPDATE change_delivery SET after_seq = <last seq> WHERE after_seq = <cursor read>`.

A failed send leaves the cursor alone, so the next flush resends. A flusher
whose update matches nothing lost a race to another flusher and stops. The
cursor never moves backwards. The API flushes after every successful write
(up to 5 batches, in `waitUntil`) and on its minutely cron (up to 50), so a
write's change is delivered within about a minute even if its own flush
failed. Write-triggered flushes are single-flight per isolate: a write while
one runs makes it loop once more instead of starting another that would
resend the same changes. Delivery is at least once and unordered; consumers
dedupe by `seq`.

Change rows are kept: `getChange` and `listChanges` read them, and there's
no retention yet.

## Upserts

`upsert(type, id, { patch, expectedRev?, version?, meta? })` is the write
for callers that don't know whether an entity exists:

| The id is…                 | Result                                                      |
| -------------------------- | ----------------------------------------------------------- |
| missing                    | created from `patch` with `null` members dropped (`create`) |
| a live entity of `type`    | `patch` applied as an RFC 7386 merge patch (`patch`)        |
| a deleted entity of `type` | recreated from `patch` alone at the next rev (`create`)     |
| an entity of another type  | `EntityTypeMismatch`                                        |

A recreated entity keeps its history and gets a new `createdAt`. Its old
links and index keys were already removed by the delete. `expectedRev: 0`
means "missing or deleted"; any other value must equal the live rev.

## Deleting types

`deleteType(name)` removes a type, its schema versions, indexes and index
entries, its deleted entities, and their revisions and changes. It's refused
(`TypeInUse`) while the type has live entities, or while another type's
latest schema links to it (older versions don't count). Both conditions are
re-checked inside the delete batch: the type row is deleted only if they
still hold, and everything else only if the type row is gone. So an entity
created concurrently is never lost.

Schema writes (`createType`, `addVersion`) re-check inside their batch that
every type they link to still exists, so a `deleteType` that commits between
the check and the write fails it with `InvalidSchema` rather than leaving a
link to a missing type.

A type can be created again under the same name. Each creation gets a random
`incarnation`, and isolates key cached schema versions by it, so they never
mix up the deleted type's versions with the new one's. A new type also
starts at a random `indexes_rev`, so a write or backfill still holding the
old type's rev (or an index generation derived from it) fails its guard
instead of matching.

## Links between entities

A `link` field holds another entity's id: `{ "type": "link", "to": "person" }`.
It can sit anywhere a type can, so `{ "type": "array", "items": { "type": "link", "to": "person" } }`
and `{ "type": "nullable", "of": { "type": "link", "to": "person" } }` work too.
A schema may only link to types that exist, or to itself.

- **Writes check targets.** Every new link must point at an existing,
  undeleted entity of the `to` type, or the write fails with `422
  LinkTargetInvalid` listing each bad path and id. An entity may link to
  itself, including while it's being created. Only links the write adds are
  checked: one extra query, and none when links don't change.
- **Deletes are refused while linked.** Deleting an entity that others link to
  fails with `409 EntityLinked` and lists who links to it. Remove those links
  first. Deleting an entity removes its own outgoing links.
- **The index.** `entity_links` mirrors the links in each entity's stored data
  and is updated in the same batch as the entity, only for links that changed.
  Two SQLite triggers make the rules hold even when a check races another
  writer: a link can only be inserted to a live entity of the right type, and
  an entity can't be marked deleted while a link points at it.
- **Reads.** `?include=links` on entity and list reads adds `included`: every
  linked entity, keyed by id, at its type's latest version.
  `GET /api/entities/:id/backlinks` lists who links to an entity.

Links are recorded per stored version: a link's `path` is the field path in
the version the source is stored at, so a lens that renames a link field
changes the path when the source is next written. If a new version turns a
plain string into a link, entities stored at the old version aren't checked
until they're rewritten at the new one.

| Operation                       | Extra rows written          |
| ------------------------------- | --------------------------- |
| write that doesn't change links | 0                           |
| each link added or removed      | 2 (link row + target index) |

## Indexes

An index lets you look entities up by a key computed from their data, such as
a person by email. It belongs to a type and is pinned to one schema version:

```json
{ "name": "email", "version": 1, "key": "lower(trim(email))", "unique": true }
```

- **Keys.** `key` is an [expression](#expression-language) evaluated against
  the entity's data lensed to `version`. It must reference fields of that
  version. A string is one key. `null` or a missing value means the entity
  isn't in the index. An array of strings gives one key per distinct element
  (non-unique indexes only, at most 64). Anything else is an error: use
  `string(age)` to index a number. Keys are at most 1024 characters.
  Lookups match keys exactly, so callers normalize the value they look up the
  same way the key does (here, lowercase and trimmed).
- **Pinned versions never go stale.** Versions and lenses are immutable, so an
  entity's keys change only when the entity does. Entities stored or written
  at later versions are lensed back to the pinned version. Adding schema
  versions never re-indexes anything. If a later version reshapes the data
  too much for an old index to be useful, create a new index at the newer
  version and drop the old one.
- **Writes.** Each write computes the entity's old and new keys and, in the
  same batch as the entity, deletes the keys it lost and inserts the ones it
  gained. Unchanged keys cost nothing. If a key can't be computed (the data
  doesn't lens to the pinned version, or the expression fails or returns a
  non-string), the write is refused with `422 IndexKeyFailed`.
- **Unique indexes.** A write that would give a second entity the same key
  fails with `409 UniqueViolation`, listing the index, key, and current
  holder. A partial unique index on `index_entries` enforces this in the
  database too, so two racing writers can't both claim a key. Deleting an
  entity frees its keys.
- **Creating an index.** The index starts `building`. Existing entities are
  backfilled in steps of 500, each committing its entries and progress
  together. The first 10 steps (5000 entities) run in the creating request.
  The rest run on the API Worker's minutely cron, or on demand via
  `POST /api/types/:type/indexes/:name/build`. Writers maintain a building
  index from the moment it's defined. Lookups need `ready` and return
  `409 IndexNotReady` until then.
- **Failure.** If the backfill finds an entity whose key can't be computed, or
  two entities with the same key in a unique index, the index becomes
  `failed` with the reason in `error`, its entries are removed, and writers
  stop maintaining it. Fix the data, then drop and recreate the index.
- **Concurrency.** `entity_types.indexes_rev` counts changes to the set of
  indexes writers maintain (create, fail, drop). Each isolate caches index
  definitions per `indexes_rev`. Every entity write batch starts with an
  insert into `index_guard` at the rev its definitions were read at, and a
  trigger aborts the batch if the rev has moved. The write then retries with
  fresh definitions, so no write can commit without maintaining an index that
  exists. The backfill inserts an entry only while the entity is still at the
  rev it read (and the index is still the same generation and building).
  Writers write every key of a building index, not just changed ones, so an
  entity the backfill skips is already covered.

At most 16 indexes per type.

| Table            | Key                              | Holds                                                  |
| ---------------- | -------------------------------- | ------------------------------------------------------ |
| `entity_indexes` | `(type, name)`                   | definition, `state`, backfill `cursor`, `generation`   |
| `index_entries`  | `(type, name, value, entity_id)` | one row per key; unique indexes also hold the key once |
| `index_guard`    | none (never holds rows)          | the write guard's trigger                              |

| Operation                         | Extra cost                                         |
| --------------------------------- | -------------------------------------------------- |
| lookup (`?index=&eq=`)            | 2 queries; 2 rows read + 2 per match               |
| write that doesn't change any key | 0 rows written                                     |
| each key added or removed         | 1 row written (2 in a unique index)                |
| write that gains a unique key     | 1 extra query (the readable conflict check)        |
| creating an index                 | 1 row read and up to 2 written per existing entity |

Writes also pay Worker CPU to lens data to each index's pinned version when
it's stored at a different one.

## Schemas are data

An entity schema is JSON. The root is always an object:

```json
{
  "description": "A person",
  "fields": {
    "name": { "type": "string", "minLength": 1 },
    "email": { "type": "string", "format": "email" },
    "age": { "type": "number", "integer": true, "min": 0, "optional": true },
    "role": { "type": "enum", "values": ["admin", "member"] },
    "tags": { "type": "array", "items": { "type": "string" }, "maxItems": 20 },
    "address": {
      "type": "object",
      "fields": {
        "city": { "type": "string" },
        "zip": { "type": "nullable", "of": { "type": "string" } }
      }
    },
    "extra": { "type": "json", "optional": true }
  }
}
```

| `type`     | Options                                                                                |
| ---------- | -------------------------------------------------------------------------------------- |
| `string`   | `minLength`, `maxLength`, `pattern`, `format` (`email` `url` `uuid` `date` `datetime`) |
| `number`   | `integer`, `min`, `max` (always finite)                                                |
| `boolean`  |                                                                                        |
| `enum`     | `values` (strings)                                                                     |
| `array`    | `items`, `minItems`, `maxItems`                                                        |
| `object`   | `fields`                                                                               |
| `nullable` | `of`                                                                                   |
| `json`     | any JSON value                                                                         |

Every node accepts `description`; object fields accept `optional: true`.

`pattern` runs on every write and read, so it's matched by a linear-time engine
(`src/schema/regex.ts`) rather than backtracking `RegExp`: literals, `.`,
classes, `\d \w \s`, `^ $`, groups, `|`, and `* + ? {n,m}` (repeat counts up
to 1000). Backreferences, lookaround, and `\b` are rejected. Lower bounds are
capped (`minLength` ≤ 1000, `minItems` ≤ 100) because the lens check generates
documents that satisfy them.
Field names are identifiers so lens expressions can refer to them. Writes
reject unknown fields. The schema compiles to an Effect Schema at runtime
(`src/schema/compile.ts`), which validates writes, validates lens output, and
generates random documents for lens checks. `GET /api/types/:t/versions/:v`
also returns standard JSON Schema for clients.

## Lenses are data

Each version after the first carries a lens from the previous version: a list
of ops, each of which runs forward (old → new) and backward (new → old).
Backward runs the ops in reverse order.

| Op                                                       | Forward                              | Backward                |
| -------------------------------------------------------- | ------------------------------------ | ----------------------- |
| `rename { from, to }`                                    | rename field                         | rename back             |
| `add { field, default? }`                                | set `default` if absent              | remove                  |
| `remove { field, default? }`                             | remove                               | set `default` if absent |
| `convert { field, mapping: [[old, new], …], fallback? }` | map values                           | map values in reverse   |
| `in { field, ops }`                                      | run `ops` inside an object field     | same, backward          |
| `each { field, ops }`                                    | run `ops` on each object in an array | same, backward          |
| `hoist { host, field }`                                  | move `host.field` up to `field`      | move it back down       |
| `plunge { host, field }`                                 | move `field` into `host.field`       | move it back up         |
| `derive { forward, backward }`                           | compute fields with expressions      | compute the other side  |

Omit `default` in `add`/`remove` when the field is optional on the side that
gains it.

`derive` maps field names to expressions. Forward sets each `forward` field
from the old document and drops the `backward` fields (they're being
replaced); backward does the opposite. Example:

```json
{
  "op": "derive",
  "forward": { "fullName": "firstName + ' ' + lastName" },
  "backward": {
    "firstName": "split(fullName, ' ')[0]",
    "lastName": "join(slice(split(fullName, ' '), 1), ' ')"
  }
}
```

A field in both maps transforms in place: `{ "forward": { "price": "price / 100" }, "backward": { "price": "price * 100" } }`.

### Expression language

Deliberately small and pure, so it is deterministic, always terminates, and
is safe to run in the API Worker on every read (`src/lens/expr.ts`):

- Identifiers read fields of the document; `$` is the whole document. Missing fields are absent, and reading through an absent value stays absent.
- Literals: numbers, `'strings'`/`"strings"`, `true`, `false`, `null`, `[arrays]`, `{ objects }`.
- Operators: `.field`, `[index]`, `! -`, `* / %`, `+ -` (numbers, string concatenation, array concatenation), `< <= > >=`, `== !=` (deep equality), `&& ||`, `??`, `cond ? a : b`.
- Functions: `string number int boolean lower upper trim split join replace slice length at first last includes startsWith endsWith concat coalesce exists typeOf round floor ceil abs min max keys values pick omit merge`, plus `map(xs, x => …)` and `filter(xs, x => …)`. `GET /api/lens/functions` lists them.
- Type mismatches (`'a' + missing`, `1 / 0`) are errors, not `NaN` or `"undefined"`.
- Each evaluation has a work budget (nodes visited plus the size of strings and arrays built), so a hostile lens fails with an error instead of exhausting the Worker. Expressions are limited to 4000 characters and 64 levels of nesting; request JSON to 64 levels.

### Checking a lens

Creating a version property-checks its lens: random documents of the old
schema must lens forward into valid new documents, random new documents must
lens backward into valid old ones, and up to 50 stored entities must survive
the forward lens. Counterexamples come back in a report and block the version
unless `force: true`. Documents that don't survive old → new → old are
reported as a warning: dropping data is sometimes the point.

## Reads and writes across versions

Data is stored at the version it was last written in. Reads lens it to the
requested version (latest by default) and validate the result; a failure is a
`ProjectionFailed` error for that entity, and lists report it per item.

Writers name the version they speak, or omit it to write at the type's
latest version as of the write. A write is validated against the writer's
schema and then:

- **Writer at or above the stored version:** stored at the writer's version.
  Entities migrate forward as they're edited, so read-time lensing shrinks
  over time.
- **Writer older than the stored version:** the store lenses the writer's
  before and after documents up to the stored version and three-way merges
  that change onto the stored data (`merge3` in `src/entity/patch.ts`).
  Objects merge key by key; arrays are aligned element by element, so
  unchanged and edited elements keep fields the old writer can't see (like
  `age` added in v2), while inserted elements get the lens defaults. If the
  result isn't valid at the stored version, the write fails with
  `ValidationFailed`.

History snapshots are stored at their own version and lensed on read, so any
past revision can be viewed in any version.
