import type { StoreError } from "./model.ts";

/**
 * How store errors are presented to callers, over HTTP and RPC alike:
 * `code` is the error's tag, `message` is for people, and the details are
 * the error's machine-readable fields.
 */
export interface ErrorBody {
  readonly code: StoreError["_tag"];
  readonly message: string;
  readonly [detail: string]: unknown;
}

export const errorBody = (error: StoreError): ErrorBody => ({
  ...detailsOf(error),
  code: error._tag,
  message: messageOf(error),
});

const messageOf = (error: StoreError): string => {
  switch (error._tag) {
    case "TypeNotFound":
      return `No entity type named '${error.type}'`;
    case "TypeAlreadyExists":
      return `Entity type '${error.type}' already exists`;
    case "TypeInUse":
      return `Entity type '${error.type}' is in use: ${error.reasons.join("; ")}`;
    case "VersionNotFound":
      return `${error.type} has no version ${error.version}`;
    case "VersionConflict":
      return `Another version of ${error.type} was added first; reload and try again`;
    case "InvalidSchema":
      return "The schema definition is invalid";
    case "InvalidLens":
      return "The lens definition is invalid";
    case "LensCheckFailed":
      return "The lens produced invalid documents; see report (or pass force: true)";
    case "EntityNotFound":
      return `No entity with id '${error.id}'`;
    case "EntityDeleted":
      return `Entity '${error.id}' was deleted at rev ${error.rev}`;
    case "EntityAlreadyExists":
      return `An entity with id '${error.id}' already exists`;
    case "EntityTypeMismatch":
      return `Entity '${error.id}' is a ${error.actual}, not a ${error.type}`;
    case "ChangeNotFound":
      return `No change is recorded for rev ${error.rev} of '${error.id}'`;
    case "RevisionNotFound":
      return `Entity '${error.id}' has no rev ${error.rev}`;
    case "RevConflict":
      return `Entity '${error.id}' is at rev ${error.currentRev}, not ${error.expectedRev}`;
    case "ValidationFailed":
      return `Data doesn't match ${error.type} v${error.version}: ${error.message}`;
    case "ProjectionFailed":
      return `Couldn't present ${error.type} v${error.from} data as v${error.to}: ${error.message}`;
    case "LinkTargetInvalid":
      return error.problems.length === 0
        ? "A linked entity doesn't exist, was deleted, or has the wrong type"
        : error.problems.map((p) => `${p.path}: ${p.message}`).join("; ");
    case "EntityLinked":
      return `Entity '${error.id}' is linked from other entities; remove those links first`;
    case "InvalidIndex":
      return "The index definition is invalid";
    case "IndexAlreadyExists":
      return `${error.type} already has an index named '${error.index}'`;
    case "IndexNotFound":
      return `${error.type} has no index named '${error.index}'`;
    case "IndexNotReady":
      return error.state === "failed"
        ? `Index '${error.index}' failed to build; see the index for why, then drop and recreate it`
        : `Index '${error.index}' is still building; try again shortly`;
    case "IndexKeyFailed":
      return `Couldn't compute index '${error.index}' for this ${error.type}: ${error.message}`;
    case "UniqueViolation":
      return error.conflicts.length === 0
        ? "Another entity already has this unique index key"
        : error.conflicts
            .map((c) => `${c.index}: '${c.key}' is taken${c.id === undefined ? "" : ` by ${c.id}`}`)
            .join("; ");
    case "StorageFailure":
      return "Storage error";
  }
};

const detailsOf = (error: StoreError): Record<string, unknown> => {
  switch (error._tag) {
    case "InvalidSchema":
    case "InvalidLens":
    case "InvalidIndex":
      return { issues: error.issues };
    case "IndexNotReady":
      return { state: error.state };
    case "UniqueViolation":
      return { conflicts: error.conflicts };
    case "LensCheckFailed":
      return { report: error.report };
    case "RevConflict":
      return { currentRev: error.currentRev };
    case "EntityDeleted":
      return { rev: error.rev };
    case "LinkTargetInvalid":
      return { problems: error.problems };
    case "EntityLinked":
      return { linkedFrom: error.linkedFrom };
    case "TypeInUse":
      return { type: error.type, reasons: error.reasons };
    case "EntityTypeMismatch":
      return { id: error.id, type: error.type, actual: error.actual };
    default:
      return {};
  }
};
