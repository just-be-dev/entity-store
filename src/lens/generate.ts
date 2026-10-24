import * as Result from "effect/Result";
import { checkDefinition } from "../schema/compile.ts";
import type { EntitySchema, FieldType } from "../schema/model.ts";
import type { Lens, LensOp } from "./model.ts";

/**
 * Generates the next schema version and its lens from a field-level edit:
 * fields added, removed, renamed, or redescribed. This is what a form that
 * edits a type in place saves, so nobody has to write a lens for the common
 * cases. It only generates ops whose meaning is certain:
 *
 * - `rename` for a field kept under a new name,
 * - `add` for a new field, which must be optional (existing entities lack it),
 * - `remove` for a dropped field, with `default: null` when it was nullable
 *   and no default when it was optional. A required, non-nullable field can't
 *   be removed here: readers of the old version would need a made-up value.
 *
 * Anything else that changes what stored data means is refused with a reason:
 * a field changing kind (string to number, a link's target, an object's
 * shape), becoming required, or gaining or losing `null`. Those need a lens
 * written by hand. Constraint changes within a kind (enum values, formats,
 * bounds) are left to the lens check, which property-checks the generated lens
 * against random and stored documents before the version is saved.
 */

/** A field of the next version. */
export interface FieldEdit {
  /** Its name in the next version. */
  readonly name: string;
  /** Its name in the current version, or undefined for a new field. */
  readonly from?: string | undefined;
  /** Its definition in the next version. */
  readonly type: FieldType;
}

/** The next version, field by field. Fields of the current version not named as a `from` are removed. */
export interface SchemaEdit {
  readonly description?: string | undefined;
  readonly title?: string | undefined;
  readonly fields: ReadonlyArray<FieldEdit>;
}

/** What a generated version changes, for showing before it's saved. */
export type FieldChange =
  | { readonly kind: "added"; readonly name: string; readonly type: FieldType }
  | { readonly kind: "removed"; readonly name: string; readonly type: FieldType }
  | {
      readonly kind: "renamed";
      readonly from: string;
      readonly to: string;
      readonly before: FieldType;
      readonly after: FieldType;
    }
  | {
      readonly kind: "changed";
      readonly name: string;
      readonly before: FieldType;
      readonly after: FieldType;
    };

export interface GeneratedVersion {
  readonly schema: EntitySchema;
  readonly lens: Lens;
  readonly changes: ReadonlyArray<FieldChange>;
  /** False when the edit describes the current version exactly: there's nothing to save. */
  readonly changed: boolean;
}

/** Sorted-key JSON, so definitions compare by content. */
export const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).toSorted(([left], [right]) => (left < right ? -1 : 1)),
        )
      : item,
  );

/** What a field holds, ignoring descriptions, optionality, `null`, and constraints. */
export const kindOf = (type: FieldType): string => {
  switch (type.type) {
    case "nullable":
      return kindOf(type.of);
    case "link":
      return `link to ${type.to}`;
    case "array":
      return `array of ${kindOf(type.items)}`;
    case "object":
      return `object {${Object.entries(type.fields)
        .toSorted(([a], [b]) => (a < b ? -1 : 1))
        .map(([name, field]) => `${name}${field.optional === true ? "?" : ""}: ${kindOf(field)}`)
        .join(", ")}}`;
    default:
      return type.type;
  }
};

const isNullable = (type: FieldType) => type.type === "nullable";
const isOptional = (type: FieldType) => type.optional === true;

/**
 * Renames in an order where no rename overwrites a field another rename still
 * has to move, or `undefined` for a cycle (a swap).
 */
const orderRenames = (
  renames: ReadonlyArray<{ readonly from: string; readonly to: string }>,
): ReadonlyArray<{ readonly from: string; readonly to: string }> | undefined => {
  const pending = [...renames];
  const ordered: Array<{ readonly from: string; readonly to: string }> = [];
  while (pending.length > 0) {
    const index = pending.findIndex(
      (rename) => !pending.some((other) => other !== rename && other.from === rename.to),
    );
    if (index === -1) {
      return undefined;
    }
    ordered.push(...pending.splice(index, 1));
  }
  return ordered;
};

/**
 * The next version of `current` that `edit` describes, with a lens from
 * `current` to it, or every reason it can't be generated.
 */
export const generateVersion = (
  current: EntitySchema,
  edit: SchemaEdit,
): Result.Result<GeneratedVersion, ReadonlyArray<string>> => {
  const problems: Array<string> = [];
  const seenNames = new Set<string>();
  const seenFrom = new Set<string>();
  for (const field of edit.fields) {
    if (seenNames.has(field.name)) {
      problems.push(`More than one field is named ${field.name}`);
    }
    seenNames.add(field.name);
    if (field.from !== undefined) {
      if (seenFrom.has(field.from)) {
        problems.push(`${field.from} is kept twice`);
      }
      seenFrom.add(field.from);
      if (!Object.hasOwn(current.fields, field.from)) {
        problems.push(`The current version has no field ${field.from}`);
      }
    }
  }

  const removes: Array<LensOp> = [];
  const renames: Array<{ readonly from: string; readonly to: string }> = [];
  const adds: Array<LensOp> = [];
  const changes: Array<FieldChange> = [];

  for (const [name, before] of Object.entries(current.fields)) {
    if (seenFrom.has(name)) {
      continue;
    }
    changes.push({ kind: "removed", name, type: before });
    if (isOptional(before)) {
      removes.push({ op: "remove", field: name });
    } else if (isNullable(before)) {
      removes.push({ op: "remove", field: name, default: null });
    } else {
      problems.push(
        `${name} is required, so removing it needs a value for readers of the current version: write that lens by hand`,
      );
    }
  }

  for (const field of edit.fields) {
    const before = field.from === undefined ? undefined : current.fields[field.from];
    if (field.from === undefined || before === undefined) {
      if (field.from === undefined) {
        changes.push({ kind: "added", name: field.name, type: field.type });
        if (isOptional(field.type)) {
          adds.push({ op: "add", field: field.name });
        } else {
          problems.push(
            `${field.name} is new, so existing entities don't have it: make it optional`,
          );
        }
      }
      continue;
    }
    const from = field.from;
    if (kindOf(before) !== kindOf(field.type)) {
      problems.push(
        `${from} holds ${kindOf(before)}; changing it to ${kindOf(field.type)} needs a hand-written lens`,
      );
    } else if (isNullable(before) !== isNullable(field.type)) {
      problems.push(
        isNullable(before)
          ? `${from} can be null now, so it can't stop allowing null without a hand-written lens`
          : `${from} can't be null now; allowing null needs a hand-written lens for readers of the current version`,
      );
    } else if (isOptional(before) && !isOptional(field.type)) {
      problems.push(
        `${from} is optional now; making it required needs a value for entities without it, in a hand-written lens`,
      );
    }
    if (from !== field.name) {
      renames.push({ from, to: field.name });
      changes.push({ kind: "renamed", from, to: field.name, before, after: field.type });
    } else if (canonicalJson(before) !== canonicalJson(field.type)) {
      changes.push({ kind: "changed", name: field.name, before, after: field.type });
    }
  }

  const ordered = orderRenames(renames);
  if (ordered === undefined) {
    problems.push("Fields can't swap names in one save: rename one of them first");
  }

  const schema: EntitySchema = {
    ...(edit.description === undefined || edit.description === ""
      ? {}
      : { description: edit.description }),
    ...(edit.title === undefined || edit.title === "" ? {} : { title: edit.title }),
    fields: Object.fromEntries(edit.fields.map((field) => [field.name, field.type])),
  };
  for (const issue of checkDefinition(schema)) {
    problems.push(issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`);
  }
  if (schema.title !== undefined && !seenNames.has(schema.title)) {
    problems.push(`The title field ${schema.title} isn't one of the fields`);
  }

  if (problems.length > 0) {
    return Result.fail(problems);
  }
  const ops: Array<LensOp> = [
    ...removes,
    ...(ordered ?? []).map(({ from, to }): LensOp => ({ op: "rename", from, to })),
    ...adds,
  ];
  return Result.succeed({
    schema,
    lens: { ops },
    changes,
    changed: canonicalJson(schema) !== canonicalJson(current),
  });
};
