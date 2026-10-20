import * as Schema from "effect/Schema";
import { LensReport } from "../lens/check.ts";
import { Lens } from "../lens/model.ts";
import {
  ENTITY_ID_PATTERN,
  EntitySchema,
  TYPE_NAME_PATTERN,
  TypeName,
  Version,
} from "../schema/model.ts";

// ─── IDs ────────────────────────────────────────────────────────────────────

export const EntityId = Schema.String.check(
  Schema.isPattern(new RegExp(ENTITY_ID_PATTERN), {
    message: "Entity ids use letters, digits, '_' or '-' (max 128)",
  }),
).pipe(Schema.brand("EntityId"));
export type EntityId = typeof EntityId.Type;

export const Rev = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

// ─── Types and versions ─────────────────────────────────────────────────────

export const Issue = Schema.Struct({ path: Schema.String, message: Schema.String });
export type Issue = typeof Issue.Type;

export const VersionInfo = Schema.Struct({
  type: TypeName,
  version: Version,
  schema: EntitySchema,
  /** Lens from `version - 1` to this version; absent for v1. */
  lens: Schema.optionalKey(Lens),
  note: Schema.String,
  createdAt: Schema.Finite,
});
export type VersionInfo = typeof VersionInfo.Type;

export const TypeSummary = Schema.Struct({
  name: TypeName,
  description: Schema.String,
  latestVersion: Version,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
});
export type TypeSummary = typeof TypeSummary.Type;

export const TypeInfo = Schema.Struct({
  ...TypeSummary.fields,
  versions: Schema.Array(VersionInfo),
});
export type TypeInfo = typeof TypeInfo.Type;

// ─── Entities ───────────────────────────────────────────────────────────────

export const Operation = Schema.Literals(["create", "replace", "patch", "delete"]);
export type Operation = typeof Operation.Type;

/** An entity as presented to a reader at a chosen schema version. */
export const Entity = Schema.Struct({
  id: EntityId,
  type: TypeName,
  /** The schema version `data` is presented in. */
  version: Version,
  /** The schema version `data` is stored at. */
  storedVersion: Version,
  rev: Rev,
  data: Schema.Json,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
});
export type Entity = typeof Entity.Type;

export const Revision = Schema.Struct({
  rev: Rev,
  op: Operation,
  version: Version,
  storedVersion: Version,
  /** The schema version the writer used for this change. */
  writerVersion: Version,
  data: Schema.Json,
  createdAt: Schema.Finite,
});
export type Revision = typeof Revision.Type;

/** An entity that couldn't be shown at the requested version. */
export const ProjectionFailure = Schema.Struct({
  id: EntityId,
  rev: Rev,
  storedVersion: Version,
  error: Schema.String,
});

export const EntityPage = Schema.Struct({
  items: Schema.Array(Entity),
  failures: Schema.Array(ProjectionFailure),
  nextCursor: Schema.optionalKey(Schema.String),
});
export type EntityPage = typeof EntityPage.Type;

export const HistoryPage = Schema.Struct({
  id: EntityId,
  type: TypeName,
  items: Schema.Array(Revision),
  failures: Schema.Array(Schema.Struct({ rev: Rev, error: Schema.String })),
  nextBefore: Schema.optionalKey(Rev),
});
export type HistoryPage = typeof HistoryPage.Type;

// ─── Links ──────────────────────────────────────────────────────────────────

/** An entity that links to another, and the field path it links from. */
export const Backlink = Schema.Struct({
  source: EntityId,
  type: TypeName,
  /** Field path in the source's stored version, e.g. `author` or `reviewers[]`. */
  path: Schema.String,
});
export type Backlink = typeof Backlink.Type;

export const BacklinkPage = Schema.Struct({
  items: Schema.Array(Backlink),
  nextCursor: Schema.optionalKey(Schema.String),
});
export type BacklinkPage = typeof BacklinkPage.Type;

export const LinkProblem = Schema.Struct({
  path: Schema.String,
  target: Schema.String,
  message: Schema.String,
});
export type LinkProblem = typeof LinkProblem.Type;

// ─── Indexes ────────────────────────────────────────────────────────────────

/** Index names follow the same rules as type names, so they're safe in URLs. */
export const IndexName = Schema.String.check(
  Schema.isPattern(TYPE_NAME_PATTERN, {
    message: "Index names start with a letter and use letters, digits, '_' or '-' (max 64)",
  }),
);
export type IndexName = typeof IndexName.Type;

/** `building` while existing entities are backfilled; lookups need `ready`. */
export const IndexState = Schema.Literals(["building", "ready", "failed"]);
export type IndexState = typeof IndexState.Type;

export const IndexInfo = Schema.Struct({
  type: TypeName,
  name: IndexName,
  /** The schema version keys are computed at. */
  version: Version,
  /** Expression evaluated against the entity's data at `version`. */
  key: Schema.String,
  unique: Schema.Boolean,
  state: IndexState,
  /** Why the backfill failed (state `failed`). */
  error: Schema.optionalKey(Schema.String),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
});
export type IndexInfo = typeof IndexInfo.Type;

/** A key a write tried to claim in a unique index, and who holds it (unknown after a race). */
export const UniqueConflict = Schema.Struct({
  index: Schema.String,
  key: Schema.String,
  id: Schema.optionalKey(Schema.String),
});
export type UniqueConflict = typeof UniqueConflict.Type;

// ─── Errors ─────────────────────────────────────────────────────────────────

export class TypeNotFound extends Schema.TaggedError<TypeNotFound>()("TypeNotFound", {
  type: Schema.String,
}) {}

export class TypeAlreadyExists extends Schema.TaggedError<TypeAlreadyExists>()(
  "TypeAlreadyExists",
  { type: Schema.String },
) {}

export class VersionNotFound extends Schema.TaggedError<VersionNotFound>()("VersionNotFound", {
  type: Schema.String,
  version: Schema.Finite,
}) {}

/** Someone else added a version first; re-read the type and try again. */
export class VersionConflict extends Schema.TaggedError<VersionConflict>()("VersionConflict", {
  type: Schema.String,
  expected: Schema.Finite,
}) {}

export class InvalidSchema extends Schema.TaggedError<InvalidSchema>()("InvalidSchema", {
  issues: Schema.Array(Issue),
}) {}

export class InvalidLens extends Schema.TaggedError<InvalidLens>()("InvalidLens", {
  issues: Schema.Array(Issue),
}) {}

export class LensCheckFailed extends Schema.TaggedError<LensCheckFailed>()("LensCheckFailed", {
  report: LensReport,
}) {}

export class EntityNotFound extends Schema.TaggedError<EntityNotFound>()("EntityNotFound", {
  id: Schema.String,
}) {}

export class EntityDeleted extends Schema.TaggedError<EntityDeleted>()("EntityDeleted", {
  id: Schema.String,
  rev: Schema.Finite,
}) {}

export class EntityAlreadyExists extends Schema.TaggedError<EntityAlreadyExists>()(
  "EntityAlreadyExists",
  { id: Schema.String },
) {}

export class RevisionNotFound extends Schema.TaggedError<RevisionNotFound>()("RevisionNotFound", {
  id: Schema.String,
  rev: Schema.Finite,
}) {}

/** The write was based on a stale revision. */
export class RevConflict extends Schema.TaggedError<RevConflict>()("RevConflict", {
  id: Schema.String,
  expectedRev: Schema.Finite,
  currentRev: Schema.Finite,
}) {}

export class ValidationFailed extends Schema.TaggedError<ValidationFailed>()("ValidationFailed", {
  type: Schema.String,
  version: Schema.Finite,
  message: Schema.String,
}) {}

/** A lens couldn't move data between versions, or its output didn't fit the target schema. */
export class ProjectionFailed extends Schema.TaggedError<ProjectionFailed>()("ProjectionFailed", {
  type: Schema.String,
  from: Schema.Finite,
  to: Schema.Finite,
  message: Schema.String,
}) {}

/** A link field points at an entity that's missing, deleted, or of the wrong type. */
export class LinkTargetInvalid extends Schema.TaggedError<LinkTargetInvalid>()(
  "LinkTargetInvalid",
  { problems: Schema.Array(LinkProblem) },
) {}

/** The entity can't be deleted while other entities link to it. */
export class EntityLinked extends Schema.TaggedError<EntityLinked>()("EntityLinked", {
  id: Schema.String,
  linkedFrom: Schema.Array(Backlink),
}) {}

export class InvalidIndex extends Schema.TaggedError<InvalidIndex>()("InvalidIndex", {
  issues: Schema.Array(Issue),
}) {}

export class IndexAlreadyExists extends Schema.TaggedError<IndexAlreadyExists>()(
  "IndexAlreadyExists",
  { type: Schema.String, index: Schema.String },
) {}

export class IndexNotFound extends Schema.TaggedError<IndexNotFound>()("IndexNotFound", {
  type: Schema.String,
  index: Schema.String,
}) {}

/** The index is still backfilling, or its backfill failed. */
export class IndexNotReady extends Schema.TaggedError<IndexNotReady>()("IndexNotReady", {
  type: Schema.String,
  index: Schema.String,
  state: IndexState,
}) {}

/** An index key couldn't be computed for the written data, so the write was refused. */
export class IndexKeyFailed extends Schema.TaggedError<IndexKeyFailed>()("IndexKeyFailed", {
  type: Schema.String,
  index: Schema.String,
  message: Schema.String,
}) {}

/** The write would give a unique index key to a second entity. */
export class UniqueViolation extends Schema.TaggedError<UniqueViolation>()("UniqueViolation", {
  type: Schema.String,
  conflicts: Schema.Array(UniqueConflict),
}) {}

/** Storage misbehaved or returned data that no longer decodes. */
export class StorageFailure extends Schema.TaggedError<StorageFailure>()("StorageFailure", {
  message: Schema.String,
}) {}

export type StoreError =
  | TypeNotFound
  | TypeAlreadyExists
  | VersionNotFound
  | VersionConflict
  | InvalidSchema
  | InvalidLens
  | LensCheckFailed
  | EntityNotFound
  | EntityDeleted
  | EntityAlreadyExists
  | RevisionNotFound
  | RevConflict
  | ValidationFailed
  | ProjectionFailed
  | LinkTargetInvalid
  | EntityLinked
  | InvalidIndex
  | IndexAlreadyExists
  | IndexNotFound
  | IndexNotReady
  | IndexKeyFailed
  | UniqueViolation
  | StorageFailure;
