# Entity store HTTP API

All routes live under `/api`, take and return JSON, and return errors as
`{ "error": string, "code": string, ...details }`. Request bodies are capped at 256 KB.

| Status | `code`                                                                               |
| ------ | ------------------------------------------------------------------------------------ |
| 400    | `BadRequest` (malformed JSON, body doesn't match the route's shape, bad query param) |
| 404    | `TypeNotFound`, `VersionNotFound`, `EntityNotFound`, `RevisionNotFound`              |
| 409    | `TypeAlreadyExists`, `EntityAlreadyExists`, `VersionConflict`, `RevConflict`,        |
|        | `EntityLinked` (`linkedFrom`)                                                        |
| 410    | `EntityDeleted` (`rev` = the delete revision)                                        |
| 413    | `BadRequest` (body too large)                                                        |
| 422    | `InvalidSchema`/`InvalidLens` (`issues`), `LensCheckFailed` (`report`),              |
|        | `ValidationFailed`, `ProjectionFailed`, `LinkTargetInvalid` (`problems`)             |
| 500    | `StorageFailure`                                                                     |

## Entity types and schema versions

| Method & path                          | Body / query                      | Returns                                 |
| -------------------------------------- | --------------------------------- | --------------------------------------- |
| `GET /api/types`                       |                                   | `{ items: TypeSummary[] }`              |
| `POST /api/types`                      | `{ name, description?, schema }`  | `201 TypeInfo` (version 1)              |
| `GET /api/types/:type`                 |                                   | `TypeInfo` (all versions, oldest first) |
| `GET /api/types/:type/versions/:v`     |                                   | `VersionInfo & { jsonSchema }`          |
| `POST /api/types/:type/versions/check` | `{ schema, lens, samples? }`      | `{ from, to, report: LensReport }`      |
| `POST /api/types/:type/versions`       | `{ schema, lens, note?, force? }` | `201 { version: VersionInfo, report }`  |

```ts
type TypeSummary = { name; description; latestVersion; createdAt; updatedAt };
type TypeInfo = TypeSummary & { versions: VersionInfo[] };
type VersionInfo = { type; version; schema: EntitySchema; lens?: Lens; note; createdAt };
```

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

| Method & path                     | Body / query                       | Returns                                                  |
| --------------------------------- | ---------------------------------- | -------------------------------------------------------- |
| `GET /api/types/:type/entities`   | `?version&cursor&limit` (≤ 200)    | `{ items: Entity[], failures, nextCursor? }`             |
| `POST /api/types/:type/entities`  | `{ id?, version, data }`           | `201 Entity`                                             |
| `GET /api/entities/:id`           | `?version&rev`                     | `Entity`                                                 |
| `PUT /api/entities/:id`           | `{ version, data, expectedRev? }`  | `Entity` (presented at `version`)                        |
| `PATCH /api/entities/:id`         | `{ version, patch, expectedRev? }` | `Entity` (RFC 7386 merge patch, `null` deletes)          |
| `DELETE /api/entities/:id`        | `?expectedRev`                     | `{ id, rev }`                                            |
| `GET /api/entities/:id/backlinks` | `?cursor&limit`                    | `{ items: Backlink[], nextCursor? }`                     |
| `GET /api/entities/:id/history`   | `?version&before&limit`            | `{ id, type, items: Revision[], failures, nextBefore? }` |

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
  On writes it is **required**: it's the version the writer speaks, so old
  clients keep working after a new version ships.
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

## Authoring helpers (no storage)

| Method & path             | Body                       | Returns                                                    |
| ------------------------- | -------------------------- | ---------------------------------------------------------- |
| `POST /api/schema/check`  | `{ schema }`               | `{ ok, issues: { path, message }[] }`                      |
| `POST /api/lens/run`      | `{ lens, direction, doc }` | `{ ok: true, output }` or `{ ok: false, error \| issues }` |
| `GET /api/lens/functions` |                            | `{ items: { name, doc, minArgs, maxArgs }[] }`             |

See [data model](data-model.md) for the schema and lens languages.
