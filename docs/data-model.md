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
  before and after documents up to the stored version, diffs them, and applies
  only that diff to the stored data. Fields the old writer can't see (like
  `age` added in v2) survive its edits. If the result isn't valid at the
  stored version, the write fails with `ValidationFailed`.

History snapshots are stored at their own version and lensed on read, so any
past revision can be viewed in any version.
