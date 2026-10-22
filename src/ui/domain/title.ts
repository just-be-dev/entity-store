import * as Option from "effect/Option";
import * as String from "effect/String";
import { field } from "./json.ts";

/**
 * An entity's display name: the field its schema's `title` names, when that
 * field holds a non-blank string. Reads the schema as opaque JSON, like the
 * rest of the UI.
 */
export const entityTitle = (schema: unknown, data: unknown): Option.Option<string> => {
  const title = field(schema, "title");
  if (typeof title !== "string") {
    return Option.none();
  }
  const value = field(data, title);
  return typeof value === "string" && String.isNonEmpty(value.trim())
    ? Option.some(value)
    : Option.none();
};
