import * as Schema from "effect/Schema";

// The entity store's wire contract (docs/api.md), as the UI reads it. Schemas
// and lenses are opaque JSON here: the UI shows and edits them as text and the
// API validates them.

export const Issue = Schema.Struct({ path: Schema.String, message: Schema.String });
export type Issue = typeof Issue.Type;

export const VersionInfo = Schema.Struct({
  type: Schema.String,
  version: Schema.Int,
  schema: Schema.Json,
  lens: Schema.OptionFromOptionalKey(Schema.Json),
  note: Schema.String,
  createdAt: Schema.Finite,
});
export type VersionInfo = typeof VersionInfo.Type;

export const TypeSummary = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  latestVersion: Schema.Int,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
});
export type TypeSummary = typeof TypeSummary.Type;

export const TypeList = Schema.Struct({ items: Schema.Array(TypeSummary) });

export const TypeInfo = Schema.Struct({
  ...TypeSummary.fields,
  versions: Schema.Array(VersionInfo),
});
export type TypeInfo = typeof TypeInfo.Type;

export const Entity = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  version: Schema.Int,
  storedVersion: Schema.Int,
  rev: Schema.Int,
  data: Schema.Json,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
});
export type Entity = typeof Entity.Type;

export const ProjectionFailure = Schema.Struct({
  id: Schema.String,
  rev: Schema.Int,
  storedVersion: Schema.Int,
  error: Schema.String,
});
export type ProjectionFailure = typeof ProjectionFailure.Type;

export const EntityPage = Schema.Struct({
  items: Schema.Array(Entity),
  failures: Schema.Array(ProjectionFailure),
  nextCursor: Schema.OptionFromOptionalKey(Schema.String),
});
export type EntityPage = typeof EntityPage.Type;

export const Operation = Schema.Literals(["create", "replace", "patch", "delete"]);

export const Revision = Schema.Struct({
  rev: Schema.Int,
  op: Operation,
  version: Schema.Int,
  storedVersion: Schema.Int,
  writerVersion: Schema.Int,
  data: Schema.Json,
  createdAt: Schema.Finite,
});
export type Revision = typeof Revision.Type;

export const RevisionFailure = Schema.Struct({ rev: Schema.Int, error: Schema.String });
export type RevisionFailure = typeof RevisionFailure.Type;

export const HistoryPage = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  items: Schema.Array(Revision),
  failures: Schema.Array(RevisionFailure),
  nextBefore: Schema.OptionFromOptionalKey(Schema.Int),
});
export type HistoryPage = typeof HistoryPage.Type;

export const Deleted = Schema.Struct({ id: Schema.String, rev: Schema.Int });

// ─── Lens checks ────────────────────────────────────────────────────────────

export const CheckFailure = Schema.Struct({
  input: Schema.Json,
  output: Schema.OptionFromOptionalKey(Schema.Json),
  error: Schema.String,
});
export type CheckFailure = typeof CheckFailure.Type;

export const DirectionReport = Schema.Struct({
  checked: Schema.Int,
  failures: Schema.Array(CheckFailure),
});
export type DirectionReport = typeof DirectionReport.Type;

export const RoundTripExample = Schema.Struct({
  input: Schema.Json,
  forward: Schema.Json,
  back: Schema.Json,
});

export const LensReport = Schema.Struct({
  ok: Schema.Boolean,
  forward: DirectionReport,
  backward: DirectionReport,
  existing: DirectionReport,
  roundTrip: Schema.Struct({
    checked: Schema.Int,
    lossy: Schema.Int,
    example: Schema.OptionFromOptionalKey(RoundTripExample),
  }),
  examples: Schema.Array(Schema.Struct({ input: Schema.Json, output: Schema.Json })),
  warnings: Schema.Array(Schema.String),
});
export type LensReport = typeof LensReport.Type;

export const VersionCheck = Schema.Struct({
  from: Schema.Int,
  to: Schema.Int,
  report: LensReport,
});
export type VersionCheck = typeof VersionCheck.Type;

export const AddedVersion = Schema.Struct({ version: VersionInfo, report: LensReport });

export const SchemaCheck = Schema.Struct({ ok: Schema.Boolean, issues: Schema.Array(Issue) });

export const LensRun = Schema.Struct({
  ok: Schema.Boolean,
  output: Schema.OptionFromOptionalKey(Schema.Json),
  error: Schema.OptionFromOptionalKey(Schema.String),
  issues: Schema.optionalKey(Schema.Array(Issue)),
});

export const LensFunction = Schema.Struct({
  name: Schema.String,
  doc: Schema.String,
  minArgs: Schema.Int,
  maxArgs: Schema.OptionFromNullOr(Schema.Int),
});
export type LensFunction = typeof LensFunction.Type;

export const LensFunctions = Schema.Struct({ items: Schema.Array(LensFunction) });

export const Direction = Schema.Literals(["forward", "backward"]);
export type Direction = typeof Direction.Type;

// ─── Failures ───────────────────────────────────────────────────────────────

/** Any failed API call, normalized. `status` is 0 when the API wasn't reached. */
export const ApiFailure = Schema.Struct({
  status: Schema.Int,
  error: Schema.String,
  code: Schema.Option(Schema.String),
  issues: Schema.Array(Issue),
  report: Schema.Option(LensReport),
  currentRev: Schema.Option(Schema.Int),
});
export type ApiFailure = typeof ApiFailure.Type;

/** The JSON error body every API route returns. */
export const ErrorBody = Schema.Struct({
  error: Schema.String,
  code: Schema.OptionFromOptionalKey(Schema.String),
  issues: Schema.optionalKey(Schema.Array(Issue)),
  report: Schema.OptionFromOptionalKey(LensReport),
  currentRev: Schema.OptionFromOptionalKey(Schema.Int),
});
