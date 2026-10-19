# Data model

## Storage layout (D1)

Four tables, defined in `migrations/0001_entity_store.sql`:

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
| create                  | 1 batch          | 1                     | 3 (entity, type index entry, revision) |
| update / patch / delete | 1 read + 1 batch | 3                     | 2 (entity, revision)                   |
| history page            | 1                | n + 2                 | 0                                      |

The batch is a D1 transaction. The revision row is copied from the entity row
inside that transaction (`INSERT … SELECT`), so history can't drift from what
was committed, and the update is conditional on the revision read
(`WHERE rev = ?`), which gives optimistic concurrency without locks. Updates
don't touch the `(type, id)` index because neither column changes.

Schema versions are immutable, so each Worker isolate caches compiled schemas
and lenses after first use; steady-state reads cost no extra queries for
schemas.

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

Writers always name their version. A write is validated against the writer's
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
