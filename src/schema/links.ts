import type { EntitySchema, FieldType } from "./model.ts";

/** One link held by a document: where it sits, which entity, and its required type. */
export interface Link {
  /** Field path in the document's own version, e.g. `author` or `reviews[].by`. */
  readonly path: string;
  readonly target: string;
  readonly targetType: string;
}

/** Entity types a schema links to. */
export const linkedTypes = (schema: EntitySchema): Set<string> => {
  const out = new Set<string>();
  const visit = (type: FieldType) => {
    switch (type.type) {
      case "link":
        out.add(type.to);
        return;
      case "array":
        visit(type.items);
        return;
      case "nullable":
        visit(type.of);
        return;
      case "object":
        Object.values(type.fields).forEach(visit);
        return;
      default:
        return;
    }
  };
  Object.values(schema.fields).forEach(visit);
  return out;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Every link in a document that is valid for `schema`, deduplicated by
 * (path, target). Array elements share the path `field[]`.
 */
export const extractLinks = (schema: EntitySchema, data: unknown): Array<Link> => {
  const seen = new Map<string, Link>();
  const visit = (type: FieldType, value: unknown, path: string) => {
    if (value === undefined || value === null) {
      return;
    }
    switch (type.type) {
      case "link":
        if (typeof value === "string") {
          seen.set(`${path}\u0000${value}`, { path, target: value, targetType: type.to });
        }
        return;
      case "array":
        if (Array.isArray(value)) {
          value.forEach((item) => visit(type.items, item, `${path}[]`));
        }
        return;
      case "nullable":
        visit(type.of, value, path);
        return;
      case "object":
        visitFields(type.fields, value, path);
        return;
      default:
        return;
    }
  };
  const visitFields = (
    fields: { readonly [name: string]: FieldType },
    value: unknown,
    path: string,
  ) => {
    if (!isObject(value)) {
      return;
    }
    for (const [name, field] of Object.entries(fields)) {
      if (Object.hasOwn(value, name)) {
        visit(field, value[name], path === "" ? name : `${path}.${name}`);
      }
    }
  };
  visitFields(schema.fields, data, "");
  return [...seen.values()];
};

const key = (link: Link) => `${link.path}\u0000${link.target}`;

/** Links to add and remove to go from `before` to `after`. */
export const diffLinks = (before: ReadonlyArray<Link>, after: ReadonlyArray<Link>) => {
  const old = new Set(before.map(key));
  const next = new Set(after.map(key));
  return {
    added: after.filter((link) => !old.has(key(link))),
    removed: before.filter((link) => !next.has(key(link))),
  };
};
