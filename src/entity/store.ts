import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type { Json, JsonObject } from "../lens/expr.ts";
import { compileLens } from "../lens/apply.ts";
import type { LensReport } from "../lens/check.ts";
import { checkLens } from "../lens/check.ts";
import type { Lens } from "../lens/model.ts";
import { checkDefinition, compiled } from "../schema/compile.ts";
import type { Link } from "../schema/links.ts";
import { diffLinks, extractLinks, linkedTypes } from "../schema/links.ts";
import type { EntitySchema } from "../schema/model.ts";
import type {
  Backlink,
  BacklinkPage,
  Entity,
  EntityPage,
  LinkProblem,
  HistoryPage,
  Operation,
  Revision,
  StoreError,
  TypeInfo,
  VersionInfo,
} from "./model.ts";
import {
  EntityAlreadyExists,
  EntityDeleted,
  EntityLinked,
  EntityNotFound,
  InvalidLens,
  InvalidSchema,
  LensCheckFailed,
  LinkTargetInvalid,
  ProjectionFailed,
  RevConflict,
  RevisionNotFound,
  StorageFailure,
  TypeAlreadyExists,
  ValidationFailed,
  VersionConflict,
  VersionNotFound,
} from "./model.ts";
import { merge3, mergePatch } from "./patch.ts";
import type { LoadedVersion } from "./registry.ts";
import { VersionCache, decodeRows, makeRegistry } from "./registry.ts";
import type { SqlError, Statement } from "./sql.ts";
import { SqlDatabase, sql } from "./sql.ts";

// ─── Rows ───────────────────────────────────────────────────────────────────

const StoredJson = Schema.fromJsonString(Schema.Json);

const EntityRow = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  version: Schema.Number,
  rev: Schema.Number,
  data: StoredJson,
  deleted: Schema.Number,
  created_at: Schema.Number,
  updated_at: Schema.Number,
  latest_version: Schema.Number,
});
type EntityRow = typeof EntityRow.Type;

const RevisionRow = Schema.Struct({
  entity_id: Schema.String,
  rev: Schema.Number,
  version: Schema.Number,
  writer_version: Schema.Number,
  op: Schema.Literals(["create", "replace", "patch", "delete"]),
  data: StoredJson,
  created_at: Schema.Number,
  type: Schema.String,
  latest_version: Schema.Number,
});

const storageFailure = (error: SqlError) => new StorageFailure({ message: error.message });

/** D1 allows 100 bound parameters per statement; stay well under it. */
const MAX_IN = 90;
const chunks = <A>(items: ReadonlyArray<A>): Array<ReadonlyArray<A>> =>
  Array.from({ length: Math.ceil(items.length / MAX_IN) }, (_, i) =>
    items.slice(i * MAX_IN, (i + 1) * MAX_IN),
  );
const placeholders = (items: ReadonlyArray<unknown>) => items.map(() => "?").join(", ");

// ─── Inputs ─────────────────────────────────────────────────────────────────

export interface CreateTypeInput {
  readonly name: string;
  readonly description?: string | undefined;
  readonly schema: EntitySchema;
}

export interface VersionInput {
  readonly schema: EntitySchema;
  readonly lens: Lens;
  readonly note?: string | undefined;
  /** Create the version even if the lens check finds counterexamples. */
  readonly force?: boolean | undefined;
}

export interface WriteOptions {
  /** The schema version the writer speaks. Required: old writers stay pinned. */
  readonly version: number;
  /** Fail with RevConflict unless the entity is at this revision. */
  readonly expectedRev?: number | undefined;
}

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;
const EXISTING_SAMPLE = 50;
const WRITE_ATTEMPTS = 8;

// ─── Service ────────────────────────────────────────────────────────────────

export class EntityStore extends Context.Service<
  EntityStore,
  Effect.Success<typeof makeEntityStore>
>()("entity-store/EntityStore") {
  /** Needs a SqlDatabase and an isolate-lifetime VersionCache. */
  static readonly layer = Layer.effect(
    EntityStore,
    Effect.suspend(() => makeEntityStore),
  );
}

const makeEntityStore = Effect.gen(function* () {
  const db = yield* SqlDatabase;
  const registry = yield* makeRegistry;

  const all = (statement: Statement) => db.all(statement).pipe(Effect.mapError(storageFailure));

  // ── Links ──

  /** Links held by `data`, which is stored at `version` of `type`. */
  const linksOf = Effect.fn("EntityStore.linksOf")(function* (
    type: string,
    version: number,
    data: Json,
  ) {
    const loaded = yield* registry.version(type, version);
    return extractLinks(loaded.info.schema, data);
  });

  /** Readable errors for new links whose targets are missing, deleted, or the wrong type. */
  const checkTargets = Effect.fn("EntityStore.checkTargets")(function* (
    links: ReadonlyArray<Link>,
    self: { readonly id: string; readonly type: string },
  ) {
    const ids = [...new Set(links.map((link) => link.target).filter((t) => t !== self.id))];
    const found = new Map<string, { readonly type: string; readonly deleted: boolean }>();
    for (const group of chunks(ids)) {
      const rows = yield* all(
        sql(
          `SELECT id, type, deleted FROM entities WHERE id IN (${placeholders(group)})`,
          ...group,
        ),
      );
      rows.forEach((row) =>
        found.set(String(row["id"]), {
          type: String(row["type"]),
          deleted: Number(row["deleted"]) !== 0,
        }),
      );
    }
    const problems: Array<LinkProblem> = [];
    for (const link of links) {
      const target =
        link.target === self.id ? { type: self.type, deleted: false } : found.get(link.target);
      const message =
        target === undefined
          ? `no entity '${link.target}'`
          : target.deleted
            ? `entity '${link.target}' was deleted`
            : target.type !== link.targetType
              ? `'${link.target}' is a ${target.type}, not a ${link.targetType}`
              : undefined;
      if (message !== undefined) {
        problems.push({ path: link.path, target: link.target, message });
      }
    }
    if (problems.length > 0) {
      return yield* new LinkTargetInvalid({ problems });
    }
  });

  const insertLink = (source: string, link: Link) =>
    sql(
      "INSERT INTO entity_links (source, path, target, target_type) VALUES (?, ?, ?, ?)",
      source,
      link.path,
      link.target,
      link.targetType,
    );

  const deleteLink = (source: string, link: Link) =>
    sql(
      "DELETE FROM entity_links WHERE source = ? AND path = ? AND target = ?",
      source,
      link.path,
      link.target,
    );

  const backlinkQuery = (where: string) =>
    `SELECT l.source, l.path, e.type FROM entity_links l JOIN entities e ON e.id = l.source WHERE ${where}`;

  const toBacklinks = (rows: ReadonlyArray<Record<string, unknown>>): Array<Backlink> =>
    rows.map((row) => ({
      source: String(row["source"]) as Backlink["source"],
      path: String(row["path"]),
      type: String(row["type"]),
    }));

  /** Translate the link triggers' errors (a lost race with another writer). */
  const writeError =
    (id: string, onConstraint: () => StoreError) =>
    (error: SqlError): StoreError =>
      error.message.includes("LINK_TARGET_INVALID")
        ? new LinkTargetInvalid({ problems: [] })
        : error.message.includes("ENTITY_LINKED")
          ? new EntityLinked({ id, linkedFrom: [] })
          : error.constraint
            ? onConstraint()
            : storageFailure(error);

  // ── Projection: run lenses between versions, then validate the result ──

  const project = Effect.fn("EntityStore.project")(function* (
    type: string,
    data: Json,
    from: number,
    to: number,
  ) {
    if (from === to) {
      return data;
    }
    const chain = yield* registry.versions(type, from, to);
    let current: Result.Result<JsonObject, string> =
      typeof data === "object" && data !== null && !Array.isArray(data)
        ? Result.succeed(data as JsonObject)
        : Result.fail("Stored data is not an object");
    let at = from;
    if (from < to) {
      for (const step of chain.slice(1)) {
        current = Result.flatMap(current, (doc) => runLens(step, "forward", doc));
        at = step.info.version;
        if (Result.isFailure(current)) {
          break;
        }
      }
    } else {
      for (const step of chain.slice(1).reverse()) {
        current = Result.flatMap(current, (doc) => runLens(step, "backward", doc));
        at = step.info.version - 1;
        if (Result.isFailure(current)) {
          break;
        }
      }
    }
    if (Result.isFailure(current)) {
      return yield* new ProjectionFailed({
        type,
        from,
        to,
        message: `Lens failed near v${at}: ${current.failure}`,
      });
    }
    const target = from < to ? chain[chain.length - 1] : chain[0];
    const valid = target === undefined ? current : target.schema.validate(current.success);
    if (Result.isFailure(valid)) {
      return yield* new ProjectionFailed({
        type,
        from,
        to,
        message: `Lens output doesn't match v${to}: ${valid.failure}`,
      });
    }
    return current.success as Json;
  });

  const runLens = (
    step: LoadedVersion,
    direction: "forward" | "backward",
    doc: JsonObject,
  ): Result.Result<JsonObject, string> =>
    step.lens === undefined ? Result.succeed(doc) : step.lens[direction](doc);

  const requireVersion = (type: string, version: number, latest: number) =>
    version >= 1 && version <= latest && Number.isInteger(version)
      ? Effect.void
      : Effect.fail(new VersionNotFound({ type, version }));

  const validate = Effect.fn("EntityStore.validate")(function* (
    type: string,
    version: number,
    data: unknown,
  ) {
    const loaded = yield* registry.version(type, version);
    const result = loaded.schema.validate(data);
    if (Result.isFailure(result)) {
      return yield* new ValidationFailed({ type, version, message: result.failure });
    }
    return data as Json;
  });

  // ── Types and versions ──

  /** Check a schema, including that every type it links to exists (or is the type itself). */
  const definitionIssues = Effect.fn("EntityStore.definitionIssues")(function* (
    schema: EntitySchema,
    self: string,
  ) {
    const issues = [...checkDefinition(schema)];
    if (issues.length === 0) {
      const targets = [...linkedTypes(schema)].filter((type) => type !== self);
      const found = new Set<string>();
      for (const group of chunks(targets)) {
        const rows = yield* all(
          sql(`SELECT name FROM entity_types WHERE name IN (${placeholders(group)})`, ...group),
        );
        rows.forEach((row) => found.add(String(row["name"])));
      }
      for (const missing of targets.filter((type) => !found.has(type))) {
        issues.push({
          path: "",
          message: `Links point at '${missing}', which isn't an entity type`,
        });
      }
    }
    if (issues.length > 0) {
      return yield* new InvalidSchema({ issues });
    }
    return compiled(schema);
  });

  const createType = Effect.fn("EntityStore.createType")(function* (input: CreateTypeInput) {
    yield* definitionIssues(input.schema, input.name);
    const now = yield* Clock.currentTimeMillis;
    yield* db
      .batch([
        sql(
          "INSERT INTO entity_types (name, description, latest_version, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
          input.name,
          input.description ?? "",
          now,
          now,
        ),
        sql(
          "INSERT INTO schema_versions (type, version, schema, lens, note, created_at) VALUES (?, 1, ?, NULL, '', ?)",
          input.name,
          JSON.stringify(input.schema),
          now,
        ),
      ])
      .pipe(
        Effect.mapError((error) =>
          error.constraint ? new TypeAlreadyExists({ type: input.name }) : storageFailure(error),
        ),
      );
    return yield* getType(input.name);
  });

  const listTypes = registry.listTypes;

  const getType = Effect.fn("EntityStore.getType")(function* (name: string) {
    const summary = yield* registry.getType(name);
    const versions = yield* registry.versions(name, 1, summary.latestVersion);
    const info: TypeInfo = { ...summary, versions: versions.map((v) => v.info) };
    return info;
  });

  const getVersion = Effect.fn("EntityStore.getVersion")(function* (name: string, version: number) {
    const summary = yield* registry.getType(name);
    yield* requireVersion(name, version, summary.latestVersion);
    return (yield* registry.version(name, version)).info;
  });

  /** Stored entities of a type, projected to `version`, to test a new lens against real data. */
  const sampleExisting = Effect.fn("EntityStore.sampleExisting")(function* (
    type: string,
    version: number,
  ) {
    const rows = yield* all(
      sql(
        "SELECT id, version, data FROM entities WHERE type = ? AND deleted = 0 ORDER BY id DESC LIMIT ?",
        type,
        EXISTING_SAMPLE,
      ),
    );
    const decoded = yield* decodeRows(
      Schema.Struct({ id: Schema.String, version: Schema.Number, data: StoredJson }),
      "entity",
    )(rows);
    const out: Array<Json> = [];
    for (const row of decoded) {
      const projected = yield* Effect.result(project(type, row.data, row.version, version));
      if (Result.isSuccess(projected)) {
        out.push(projected.success);
      }
    }
    return out;
  });

  /** Validate a proposed next version and property-check its lens, without saving. */
  const checkVersion = Effect.fn("EntityStore.checkVersion")(function* (
    name: string,
    input: Omit<VersionInput, "force" | "note">,
    options?: { readonly samples?: number },
  ) {
    const summary = yield* registry.getType(name);
    const to = yield* definitionIssues(input.schema, name);
    const lens = compileLens(input.lens);
    if (Result.isFailure(lens)) {
      return yield* new InvalidLens({ issues: lens.failure });
    }
    const from = yield* registry.version(name, summary.latestVersion);
    const existing = yield* sampleExisting(name, summary.latestVersion);
    const report: LensReport = yield* checkLens({
      from: from.schema,
      to,
      lens: lens.success,
      existing,
      ...(options?.samples === undefined ? {} : { samples: options.samples }),
    });
    return { from: summary.latestVersion, to: summary.latestVersion + 1, report };
  });

  const addVersion = Effect.fn("EntityStore.addVersion")(function* (
    name: string,
    input: VersionInput,
  ) {
    const checked = yield* checkVersion(name, input);
    if (!checked.report.ok && input.force !== true) {
      return yield* new LensCheckFailed({ report: checked.report });
    }
    const now = yield* Clock.currentTimeMillis;
    const results = yield* db
      .batch([
        sql(
          "INSERT INTO schema_versions (type, version, schema, lens, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          name,
          checked.to,
          JSON.stringify(input.schema),
          JSON.stringify(input.lens),
          input.note ?? "",
          now,
        ),
        sql(
          "UPDATE entity_types SET latest_version = ?, updated_at = ? WHERE name = ? AND latest_version = ?",
          checked.to,
          now,
          name,
          checked.from,
        ),
      ])
      .pipe(
        Effect.mapError((error) =>
          error.constraint
            ? new VersionConflict({ type: name, expected: checked.from })
            : storageFailure(error),
        ),
      );
    if (results[1]?.changes !== 1) {
      // NOTE: D1 batches are transactions, so a lost race here also failed the
      // insert above on its primary key; this is a belt-and-braces check.
      return yield* new VersionConflict({ type: name, expected: checked.from });
    }
    const info: VersionInfo = (yield* registry.version(name, checked.to)).info;
    return { version: info, report: checked.report };
  });

  // ── Entities ──

  const readRow = Effect.fn("EntityStore.readRow")(function* (id: string) {
    const rows = yield* all(
      sql(
        "SELECT e.*, t.latest_version FROM entities e JOIN entity_types t ON t.name = e.type WHERE e.id = ?",
        id,
      ),
    );
    const [row] = yield* decodeRows(EntityRow, "entity")(rows);
    if (row === undefined) {
      return yield* new EntityNotFound({ id });
    }
    return row;
  });

  const present = Effect.fn("EntityStore.present")(function* (row: EntityRow, version: number) {
    const data = yield* project(row.type, row.data, row.version, version);
    const entity: Entity = {
      id: row.id as Entity["id"],
      type: row.type,
      version,
      storedVersion: row.version,
      rev: row.rev,
      data,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    return entity;
  });

  const newId = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const nibbles = yield* Effect.forEach(Array.from({ length: 19 }), () =>
      Effect.map(Random.next, (r) => Math.floor(r * 16).toString(16)),
    );
    const ts = Math.floor(now).toString(16).padStart(12, "0").slice(-12);
    const rand = nibbles.join("");
    const variant = ((parseInt(rand.charAt(3), 16) & 0x3) | 0x8).toString(16);
    // UUIDv7 layout: time-ordered, so ids sort roughly by creation time.
    return `${ts.slice(0, 8)}-${ts.slice(8)}-7${rand.slice(0, 3)}-${variant}${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
  });

  /** Copies the new head row into history, so a revision always matches what was committed. */
  const appendRevision = (id: string, rev: number, writerVersion: number, op: Operation) =>
    sql(
      "INSERT INTO entity_revisions (entity_id, rev, version, writer_version, op, data, created_at) SELECT id, rev, version, ?, ?, data, updated_at FROM entities WHERE id = ? AND rev = ?",
      writerVersion,
      op,
      id,
      rev,
    );

  const create = Effect.fn("EntityStore.create")(function* (
    type: string,
    input: { readonly id?: string | undefined; readonly version: number; readonly data: unknown },
  ) {
    const summary = yield* registry.getType(type);
    yield* requireVersion(type, input.version, summary.latestVersion);
    const data = yield* validate(type, input.version, input.data);
    const id = input.id ?? (yield* newId);
    const links = yield* linksOf(type, input.version, data);
    yield* checkTargets(links, { id, type });
    const now = yield* Clock.currentTimeMillis;
    yield* db
      .batch([
        sql(
          "INSERT INTO entities (id, type, version, rev, data, deleted, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 0, ?, ?)",
          id,
          type,
          input.version,
          JSON.stringify(data),
          now,
          now,
        ),
        appendRevision(id, 1, input.version, "create"),
        ...links.map((link) => insertLink(id, link)),
      ])
      .pipe(Effect.mapError(writeError(id, () => new EntityAlreadyExists({ id }))));
    const entity: Entity = {
      id: id as Entity["id"],
      type,
      version: input.version,
      storedVersion: input.version,
      rev: 1,
      data,
      createdAt: now,
      updatedAt: now,
    };
    return entity;
  });

  const get = Effect.fn("EntityStore.get")(function* (
    id: string,
    options?: { readonly version?: number | undefined; readonly rev?: number | undefined },
  ) {
    if (options?.rev !== undefined) {
      return yield* getRevision(id, options.rev, options.version);
    }
    const row = yield* readRow(id);
    if (row.deleted !== 0) {
      return yield* new EntityDeleted({ id, rev: row.rev });
    }
    const version = options?.version ?? row.latest_version;
    yield* requireVersion(row.type, version, row.latest_version);
    return yield* present(row, version);
  });

  const revisionQuery = (where: string) =>
    `SELECT r.*, e.type, t.latest_version FROM entity_revisions r JOIN entities e ON e.id = r.entity_id JOIN entity_types t ON t.name = e.type WHERE ${where}`;

  const getRevision = Effect.fn("EntityStore.getRevision")(function* (
    id: string,
    rev: number,
    requested: number | undefined,
  ) {
    const rows = yield* all(sql(revisionQuery("r.entity_id = ? AND r.rev = ?"), id, rev));
    const [row] = yield* decodeRows(RevisionRow, "revision")(rows);
    if (row === undefined) {
      return yield* new RevisionNotFound({ id, rev });
    }
    const version = requested ?? row.latest_version;
    yield* requireVersion(row.type, version, row.latest_version);
    const data = yield* project(row.type, row.data, row.version, version);
    const entity: Entity = {
      id: id as Entity["id"],
      type: row.type,
      version,
      storedVersion: row.version,
      rev: row.rev,
      data,
      createdAt: row.created_at,
      updatedAt: row.created_at,
    };
    return entity;
  });

  const list = Effect.fn("EntityStore.list")(function* (
    type: string,
    options?: {
      readonly version?: number | undefined;
      readonly cursor?: string | undefined;
      readonly limit?: number | undefined;
    },
  ) {
    const summary = yield* registry.getType(type);
    const version = options?.version ?? summary.latestVersion;
    yield* requireVersion(type, version, summary.latestVersion);
    const limit = Math.max(1, Math.min(options?.limit ?? DEFAULT_PAGE, MAX_PAGE));
    const rows = yield* all(
      sql(
        "SELECT e.*, ? AS latest_version FROM entities e WHERE e.type = ? AND e.id > ? AND e.deleted = 0 ORDER BY e.id LIMIT ?",
        summary.latestVersion,
        type,
        options?.cursor ?? "",
        limit + 1,
      ),
    );
    const decoded = yield* decodeRows(EntityRow, "entity")(rows);
    const pageRows = decoded.slice(0, limit);
    const items: Array<Entity> = [];
    const failures: Array<EntityPage["failures"][number]> = [];
    for (const row of pageRows) {
      const presented = yield* Effect.result(present(row, version));
      if (Result.isSuccess(presented)) {
        items.push(presented.success);
      } else {
        failures.push({
          id: row.id as Entity["id"],
          rev: row.rev,
          storedVersion: row.version,
          error: presented.failure.message,
        });
      }
    }
    const last = pageRows[pageRows.length - 1];
    const page: EntityPage = {
      items,
      failures,
      ...(decoded.length > limit && last !== undefined ? { nextCursor: last.id } : {}),
    };
    return page;
  });

  /**
   * The write path shared by replace, patch, and delete.
   *
   * The writer sees the entity at its own version, and its change is validated
   * against that version's schema. Then:
   * - If the writer's version is at least the stored version, the result is
   *   stored at the writer's version (entities migrate forward as they're edited).
   * - If the writer is older, only what it changed is carried forward: both the
   *   before and after documents are lensed up to the stored version, diffed,
   *   and the diff applied to the stored data. Fields the old writer can't see
   *   are left alone.
   */
  const mutate = (
    id: string,
    options: WriteOptions,
    op: Operation,
    change: (current: Json) => Json,
  ) =>
    Effect.gen(function* () {
      const row = yield* readRow(id);
      if (row.deleted !== 0) {
        return yield* new EntityDeleted({ id, rev: row.rev });
      }
      if (options.expectedRev !== undefined && options.expectedRev !== row.rev) {
        return yield* new RevConflict({
          id,
          expectedRev: options.expectedRev,
          currentRev: row.rev,
        });
      }
      // Deletes don't speak a version; record them at the stored one on every attempt.
      const writer = op === "delete" ? row.version : options.version;
      yield* requireVersion(row.type, writer, row.latest_version);
      const before = yield* project(row.type, row.data, row.version, writer);
      const after = op === "delete" ? before : yield* validate(row.type, writer, change(before));

      let storedVersion = writer;
      let stored = after;
      if (writer < row.version) {
        const beforeUp = yield* project(row.type, before, writer, row.version);
        const afterUp = yield* project(row.type, after, writer, row.version);
        storedVersion = row.version;
        stored = merge3(beforeUp, afterUp, row.data);
        const valid = (yield* registry.version(row.type, row.version)).schema.validate(stored);
        if (Result.isFailure(valid)) {
          return yield* new ValidationFailed({
            type: row.type,
            version: row.version,
            message: `This v${writer} change can't be applied to data stored at v${row.version}: ${valid.failure}`,
          });
        }
      }

      const oldLinks = yield* linksOf(row.type, row.version, row.data);
      const newLinks = op === "delete" ? [] : yield* linksOf(row.type, storedVersion, stored);
      const links = diffLinks(oldLinks, newLinks);
      yield* checkTargets(links.added, { id, type: row.type });
      if (op === "delete") {
        const linkedFrom = yield* all(
          sql(`${backlinkQuery("l.target = ? AND l.source != ?")} LIMIT 20`, id, id),
        );
        if (linkedFrom.length > 0) {
          return yield* new EntityLinked({ id, linkedFrom: toBacklinks(linkedFrom) });
        }
      }

      const now = yield* Clock.currentTimeMillis;
      const nextRev = row.rev + 1;
      const json = JSON.stringify(stored);
      // The revision insert goes first: revisions are contiguous, so its primary
      // key fails (aborting the whole batch) iff another write already moved
      // the entity past the rev we read. Everything after it is safe to apply.
      const results = yield* db
        .batch([
          sql(
            "INSERT INTO entity_revisions (entity_id, rev, version, writer_version, op, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            id,
            nextRev,
            storedVersion,
            writer,
            op,
            json,
            now,
          ),
          // Removed links go before the update so deleting an entity that links
          // to itself doesn't trip the delete guard.
          ...links.removed.map((link) => deleteLink(id, link)),
          sql(
            "UPDATE entities SET version = ?, rev = ?, data = ?, deleted = ?, updated_at = ? WHERE id = ? AND rev = ?",
            storedVersion,
            nextRev,
            json,
            op === "delete" ? 1 : 0,
            now,
            id,
            row.rev,
          ),
          ...links.added.map((link) => insertLink(id, link)),
        ])
        .pipe(
          Effect.mapError(
            writeError(
              id,
              () => new RevConflict({ id, expectedRev: row.rev, currentRev: nextRev }),
            ),
          ),
        );
      if (results[1 + links.removed.length]?.changes !== 1) {
        return yield* new StorageFailure({
          message: "Entity update matched no row after its revision was recorded",
        });
      }
      const entity: Entity = {
        id: id as Entity["id"],
        type: row.type,
        version: writer,
        storedVersion,
        rev: nextRev,
        data: storedVersion === writer ? stored : after,
        createdAt: row.created_at,
        updatedAt: now,
      };
      return entity;
    }).pipe(
      // Blind writes (no expectedRev) retry a lost race against a fresh read,
      // with jittered backoff so hot entities don't retry in lockstep.
      Effect.retry({
        schedule: Schedule.jittered(Schedule.exponential("10 millis")),
        times: options.expectedRev === undefined ? WRITE_ATTEMPTS - 1 : 0,
        while: (error) => error._tag === "RevConflict",
      }),
    );

  const replace = Effect.fn("EntityStore.replace")(function* (
    id: string,
    options: WriteOptions & { readonly data: unknown },
  ) {
    return yield* mutate(id, options, "replace", () => options.data as Json);
  });

  const patch = Effect.fn("EntityStore.patch")(function* (
    id: string,
    options: WriteOptions & { readonly patch: unknown },
  ) {
    return yield* mutate(id, options, "patch", (current) =>
      mergePatch(current, options.patch as Json),
    );
  });

  const remove = Effect.fn("EntityStore.remove")(function* (
    id: string,
    options?: { readonly expectedRev?: number | undefined },
  ) {
    const row = yield* readRow(id);
    if (row.deleted !== 0) {
      return { id, rev: row.rev };
    }
    const deleted = yield* mutate(
      id,
      { version: row.latest_version, expectedRev: options?.expectedRev },
      "delete",
      (current) => current,
    );
    return { id, rev: deleted.rev };
  });

  const history = Effect.fn("EntityStore.history")(function* (
    id: string,
    options?: {
      readonly version?: number | undefined;
      readonly before?: number | undefined;
      readonly limit?: number | undefined;
    },
  ) {
    const limit = Math.max(1, Math.min(options?.limit ?? DEFAULT_PAGE, MAX_PAGE));
    const rows = yield* all(
      sql(
        `${revisionQuery("r.entity_id = ? AND r.rev < ?")} ORDER BY r.rev DESC LIMIT ?`,
        id,
        options?.before ?? Number.MAX_SAFE_INTEGER,
        limit + 1,
      ),
    );
    const decoded = yield* decodeRows(RevisionRow, "revision")(rows);
    const first = decoded[0];
    if (first === undefined) {
      if (options?.before === undefined) {
        return yield* new EntityNotFound({ id });
      }
      const head = yield* readRow(id);
      const empty: HistoryPage = {
        id: id as Entity["id"],
        type: head.type,
        items: [],
        failures: [],
      };
      return empty;
    }
    const version = options?.version ?? first.latest_version;
    yield* requireVersion(first.type, version, first.latest_version);
    const items: Array<Revision> = [];
    const failures: Array<HistoryPage["failures"][number]> = [];
    const pageRows = decoded.slice(0, limit);
    for (const row of pageRows) {
      const data = yield* Effect.result(project(row.type, row.data, row.version, version));
      if (Result.isFailure(data)) {
        failures.push({ rev: row.rev, error: data.failure.message });
        continue;
      }
      items.push({
        rev: row.rev,
        op: row.op,
        version,
        storedVersion: row.version,
        writerVersion: row.writer_version,
        data: data.success,
        createdAt: row.created_at,
      });
    }
    const last = pageRows[pageRows.length - 1];
    const page: HistoryPage = {
      id: id as Entity["id"],
      type: first.type,
      items,
      failures,
      ...(decoded.length > limit && last !== undefined ? { nextBefore: last.rev } : {}),
    };
    return page;
  });

  /**
   * The entities that `entities` link to, keyed by id and presented at each
   * target type's latest version. One query per 90 distinct targets.
   */
  const resolveLinks = Effect.fn("EntityStore.resolveLinks")(function* (
    entities: ReadonlyArray<Entity>,
  ) {
    const ids = new Set<string>();
    for (const entity of entities) {
      for (const link of yield* linksOf(entity.type, entity.version, entity.data)) {
        ids.add(link.target);
      }
    }
    const included: Record<string, Entity> = {};
    for (const group of chunks([...ids])) {
      const rows = yield* all(
        sql(
          `SELECT e.*, t.latest_version FROM entities e JOIN entity_types t ON t.name = e.type WHERE e.id IN (${placeholders(group)}) AND e.deleted = 0`,
          ...group,
        ),
      );
      for (const row of yield* decodeRows(EntityRow, "entity")(rows)) {
        const presented = yield* Effect.result(present(row, row.latest_version));
        if (Result.isSuccess(presented)) {
          Object.defineProperty(included, row.id, {
            value: presented.success,
            enumerable: true,
          });
        }
      }
    }
    return included;
  });

  /** Entities whose stored data links to `id`, ordered by source id then path. */
  const backlinks = Effect.fn("EntityStore.backlinks")(function* (
    id: string,
    options?: { readonly cursor?: string | undefined; readonly limit?: number | undefined },
  ) {
    yield* readRow(id);
    const limit = Math.max(1, Math.min(options?.limit ?? DEFAULT_PAGE, MAX_PAGE));
    const slash = options?.cursor?.indexOf("/") ?? -1;
    const [afterSource, afterPath] =
      options?.cursor === undefined || slash < 0
        ? ["", ""]
        : [options.cursor.slice(0, slash), options.cursor.slice(slash + 1)];
    const rows = yield* all(
      sql(
        `${backlinkQuery("l.target = ? AND (l.source > ? OR (l.source = ? AND l.path > ?))")} ORDER BY l.source, l.path LIMIT ?`,
        id,
        afterSource,
        afterSource,
        afterPath,
        limit + 1,
      ),
    );
    const items = toBacklinks(rows.slice(0, limit));
    const last = items[items.length - 1];
    const page: BacklinkPage = {
      items,
      ...(rows.length > limit && last !== undefined
        ? { nextCursor: `${last.source}/${last.path}` }
        : {}),
    };
    return page;
  });

  return {
    createType,
    listTypes,
    getType,
    getVersion,
    checkVersion,
    addVersion,
    create,
    get,
    list,
    replace,
    patch,
    remove,
    history,
    resolveLinks,
    backlinks,
  };
});

export { VersionCache };
