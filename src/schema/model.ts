import * as Schema from "effect/Schema";

/**
 * Schemas are data. An entity schema is a JSON document stored in D1, authored
 * through the API/UI, and compiled to an Effect Schema at runtime.
 *
 * Every type node may carry `optional` (only meaningful as an object field) and
 * a `description` for people reading the schema.
 */

interface Common {
  readonly optional?: boolean | undefined;
  readonly description?: string | undefined;
}

export interface StringType extends Common {
  readonly type: "string";
  readonly minLength?: number | undefined;
  readonly maxLength?: number | undefined;
  readonly pattern?: string | undefined;
  readonly format?: "email" | "url" | "uuid" | "date" | "datetime" | undefined;
}

export interface NumberType extends Common {
  readonly type: "number";
  readonly integer?: boolean | undefined;
  readonly min?: number | undefined;
  readonly max?: number | undefined;
}

export interface BooleanType extends Common {
  readonly type: "boolean";
}

export interface EnumType extends Common {
  readonly type: "enum";
  readonly values: ReadonlyArray<string>;
}

export interface ArrayType extends Common {
  readonly type: "array";
  readonly items: FieldType;
  readonly minItems?: number | undefined;
  readonly maxItems?: number | undefined;
}

export interface ObjectType extends Common {
  readonly type: "object";
  readonly fields: { readonly [name: string]: FieldType };
}

export interface NullableType extends Common {
  readonly type: "nullable";
  readonly of: FieldType;
}

/** Any JSON value. An escape hatch for loosely structured data. */
export interface JsonType extends Common {
  readonly type: "json";
}

/**
 * A link to another entity, stored as its id. Writes check that the target
 * exists, isn't deleted, and has type `to`; deleting a linked-to entity is
 * refused while links to it remain.
 */
export interface LinkType extends Common {
  readonly type: "link";
  readonly to: string;
}

export type FieldType =
  | StringType
  | NumberType
  | BooleanType
  | EnumType
  | ArrayType
  | ObjectType
  | NullableType
  | JsonType
  | LinkType;

const common = {
  optional: Schema.optionalKey(Schema.Boolean),
  description: Schema.optionalKey(Schema.String),
};

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const FieldTypeRef = Schema.suspend((): Schema.Codec<FieldType> => FieldType);

export const FieldType: Schema.Codec<FieldType> = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("string"),
    minLength: Schema.optionalKey(Count),
    maxLength: Schema.optionalKey(Count),
    pattern: Schema.optionalKey(Schema.String),
    format: Schema.optionalKey(Schema.Literals(["email", "url", "uuid", "date", "datetime"])),
    ...common,
  }),
  Schema.Struct({
    type: Schema.Literal("number"),
    integer: Schema.optionalKey(Schema.Boolean),
    min: Schema.optionalKey(Schema.Finite),
    max: Schema.optionalKey(Schema.Finite),
    ...common,
  }),
  Schema.Struct({ type: Schema.Literal("boolean"), ...common }),
  Schema.Struct({ type: Schema.Literal("enum"), values: Schema.Array(Schema.String), ...common }),
  Schema.Struct({
    type: Schema.Literal("array"),
    items: FieldTypeRef,
    minItems: Schema.optionalKey(Count),
    maxItems: Schema.optionalKey(Count),
    ...common,
  }),
  Schema.Struct({
    type: Schema.Literal("object"),
    fields: Schema.Record(Schema.String, FieldTypeRef),
    ...common,
  }),
  Schema.Struct({ type: Schema.Literal("nullable"), of: FieldTypeRef, ...common }),
  Schema.Struct({ type: Schema.Literal("json"), ...common }),
  Schema.Struct({ type: Schema.Literal("link"), to: Schema.String, ...common }),
]);

/**
 * The root of every entity schema is an object. `title` names the top-level
 * string field that is an entity's display name.
 */
export const EntitySchema = Schema.Struct({
  description: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  fields: Schema.Record(Schema.String, FieldType),
});
export type EntitySchema = typeof EntitySchema.Type;

/** Field names are identifiers so they can be referenced from lens expressions. */
export const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "true",
  "false",
  "null",
]);

export const isFieldName = (name: string) =>
  FIELD_NAME.test(name) && !RESERVED_NAMES.has(name) && name.length <= 64;

export const TYPE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * Entity ids: what link fields hold. `.` and `@` allow ids like
 * `ada@example.com`. An id must also have something besides dots
 * ({@link isDotsOnly}): `.` and `..` can't be addressed in a URL path.
 */
export const ENTITY_ID_PATTERN = "^[A-Za-z0-9_.@-]{1,128}$";

/** True for ids like `.` and `..`, which match the pattern but aren't allowed. */
export const isDotsOnly = (id: string): boolean => /^\.+$/.test(id);

/** Entity type names: lowercase-ish slugs that are safe in URLs. */
export const TypeName = Schema.String.check(
  Schema.isPattern(TYPE_NAME_PATTERN, {
    message: "Type names start with a letter and use letters, digits, '_' or '-' (max 64)",
  }),
);
export type TypeName = typeof TypeName.Type;

export const Version = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
export type Version = typeof Version.Type;
