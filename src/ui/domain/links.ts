import * as Array from "effect/Array";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import type * as Schema from "effect/Schema";
import { asObject, field } from "./json.ts";

/** A link found in a document: the field path (array elements share `field[]`) and target id. */
export interface OutgoingLink {
  readonly path: string;
  readonly target: string;
  readonly targetType: string;
}

const childPath = (path: string, name: string) => (path === "" ? name : `${path}.${name}`);

const visit = (type: unknown, value: unknown, path: string): ReadonlyArray<OutgoingLink> => {
  if (value === undefined || value === null) {
    return [];
  }
  const kind = field(type, "type");
  if (kind === "link") {
    const to = field(type, "to");
    return typeof value === "string"
      ? [{ path, target: value, targetType: typeof to === "string" ? to : "" }]
      : [];
  }
  if (kind === "array") {
    return globalThis.Array.isArray(value)
      ? Array.flatMap(value, (item) => visit(field(type, "items"), item, `${path}[]`))
      : [];
  }
  if (kind === "nullable") {
    return visit(field(type, "of"), value, path);
  }
  if (kind === "object") {
    return visitFields(field(type, "fields"), value, path);
  }
  return [];
};

const visitFields = (fields: unknown, value: unknown, path: string): ReadonlyArray<OutgoingLink> =>
  Option.match(Option.all([asObject(fields), asObject(value)]), {
    onNone: () => [],
    onSome: ([types, object]) =>
      Array.flatMap(Record.toEntries(types), ([name, type]) =>
        Object.hasOwn(object, name) ? visit(type, object[name], childPath(path, name)) : [],
      ),
  });

/**
 * Every link in `data` according to an entity schema (docs/data-model.md),
 * deduplicated by path and target, the way the API indexes them.
 */
export const outgoingLinks = (
  schema: Schema.Json,
  data: Schema.Json,
): ReadonlyArray<OutgoingLink> =>
  Array.dedupeWith(
    visitFields(field(schema, "fields"), data, ""),
    (a, b) => a.path === b.path && a.target === b.target,
  );

const targetTypes = (type: unknown): ReadonlyArray<string> => {
  const kind = field(type, "type");
  if (kind === "link") {
    const to = field(type, "to");
    return typeof to === "string" ? [to] : [];
  }
  if (kind === "array") {
    return targetTypes(field(type, "items"));
  }
  if (kind === "nullable") {
    return targetTypes(field(type, "of"));
  }
  if (kind === "object") {
    return fieldTargetTypes(field(type, "fields"));
  }
  return [];
};

const fieldTargetTypes = (fields: unknown): ReadonlyArray<string> =>
  Option.match(asObject(fields), {
    onNone: () => [],
    onSome: (types) => Array.flatMap(Record.values(types), targetTypes),
  });

/** The entity types a schema links to, in field order, without repeats. */
export const linkedTypes = (schema: Schema.Json): ReadonlyArray<string> =>
  Array.dedupe(fieldTargetTypes(field(schema, "fields")));
