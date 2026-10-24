import * as Array from "effect/Array";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as String from "effect/String";
import { modifyFields } from "foldkit/struct";
import {
  type FieldEdit,
  type GeneratedVersion,
  type SchemaEdit,
  generateVersion,
} from "../../lens/generate.ts";
import { EntitySchema, FieldType, isFieldName } from "../../schema/model.ts";

// A type as the type form edits it: one row per top-level field, each with a
// kind people recognize (text, number, a date, a link to another type…), and
// the title chosen by row, so renaming the title field keeps it the title.

export const FieldKind = Schema.Literals([
  "text",
  "number",
  "integer",
  "boolean",
  "date",
  "datetime",
  "email",
  "url",
  "choice",
  "link",
  "json",
  "other",
]);
export type FieldKind = typeof FieldKind.Type;

export const kindLabels: Readonly<Record<FieldKind, string>> = {
  text: "Text",
  number: "Number",
  integer: "Whole number",
  boolean: "Yes / no",
  date: "Date",
  datetime: "Date and time",
  email: "Email",
  url: "URL",
  choice: "Choice",
  link: "Link",
  json: "Any JSON",
  other: "Other (edit as JSON)",
};

/** The kinds the form offers. `other` only appears for a field that already is one. */
export const formKinds: ReadonlyArray<FieldKind> = [
  "text",
  "number",
  "integer",
  "boolean",
  "date",
  "datetime",
  "email",
  "url",
  "choice",
  "link",
  "json",
];

/** Kinds whose values are strings, so the field can be an entity's title. */
const titleKinds: ReadonlySet<FieldKind> = new Set(["text", "email", "url", "date", "datetime"]);

export const FieldDraft = Schema.Struct({
  /** Stable for the row's life, so the title survives a rename. */
  key: Schema.Int,
  name: Schema.String,
  /** The field's name in the version being edited; none for a new field. */
  maybeOrigin: Schema.Option(Schema.String),
  kind: FieldKind,
  /** A link's target type. */
  to: Schema.String,
  /** A choice's values, comma-separated. */
  values: Schema.String,
  isRequired: Schema.Boolean,
  description: Schema.String,
  /** The definition it was read from, so constraints the form doesn't show survive. */
  maybeOriginal: Schema.Option(FieldType),
});
export type FieldDraft = typeof FieldDraft.Type;

export const TypeDraft = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  maybeTitleKey: Schema.Option(Schema.Int),
  fields: Schema.Array(FieldDraft),
  nextKey: Schema.Int,
});
export type TypeDraft = typeof TypeDraft.Type;

export const blankField = (key: number): FieldDraft =>
  FieldDraft.make({
    key,
    name: "",
    maybeOrigin: Option.none(),
    kind: "text",
    to: "",
    values: "",
    isRequired: false,
    description: "",
    maybeOriginal: Option.none(),
  });

/** A new type starts with a required `name` that titles each entity. */
export const newTypeDraft: TypeDraft = TypeDraft.make({
  name: "",
  description: "",
  maybeTitleKey: Option.some(0),
  fields: [modifyFields(blankField(0), { name: () => "name", isRequired: () => true })],
  nextKey: 1,
});

const inner = (type: FieldType): FieldType => (type.type === "nullable" ? inner(type.of) : type);

/** The form's kind for a stored definition. */
export const kindOf = (type: FieldType): FieldKind => {
  const of = inner(type);
  switch (of.type) {
    case "string":
      return of.format === "date"
        ? "date"
        : of.format === "datetime"
          ? "datetime"
          : of.format === "email"
            ? "email"
            : of.format === "url"
              ? "url"
              : "text";
    case "number":
      return of.integer === true ? "integer" : "number";
    case "boolean":
      return "boolean";
    case "enum":
      return "choice";
    case "link":
      return "link";
    case "json":
      return "json";
    default:
      return "other";
  }
};

const fieldDraftOf = (key: number, name: string, type: FieldType): FieldDraft => {
  const of = inner(type);
  return FieldDraft.make({
    key,
    name,
    maybeOrigin: Option.some(name),
    kind: kindOf(type),
    to: of.type === "link" ? of.to : "",
    values: of.type === "enum" ? of.values.join(", ") : "",
    isRequired: type.optional !== true,
    description: type.description ?? of.description ?? "",
    maybeOriginal: Option.some(type),
  });
};

/** The form for a stored schema, as the version being edited. */
export const draftOf = (name: string, schema: EntitySchema): TypeDraft => {
  const fields = Array.map(Record.toEntries(schema.fields), ([field, type], key) =>
    fieldDraftOf(key, field, type),
  );
  return TypeDraft.make({
    name,
    description: schema.description ?? "",
    maybeTitleKey: Option.map(
      Array.findFirst(fields, (field) => field.name === schema.title),
      (field) => field.key,
    ),
    fields,
    nextKey: fields.length,
  });
};

/** A stored schema, decoded from the UI's opaque JSON. */
export const decodeSchema = Schema.decodeUnknownOption(EntitySchema);

const choiceValues = (text: string): ReadonlyArray<string> =>
  Array.dedupe(Array.filter(Array.map(String.split(text, ","), String.trim), String.isNonEmpty));

const freshNode = (field: FieldDraft): FieldType => {
  switch (field.kind) {
    case "text":
    case "other":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "integer":
      return { type: "number", integer: true };
    case "boolean":
      return { type: "boolean" };
    case "date":
      return { type: "string", format: "date" };
    case "datetime":
      return { type: "string", format: "datetime" };
    case "email":
      return { type: "string", format: "email" };
    case "url":
      return { type: "string", format: "url" };
    case "choice":
      return { type: "enum", values: choiceValues(field.values) };
    case "link":
      return { type: "link", to: field.to };
    case "json":
      return { type: "json" };
  }
};

/** The definition with this row's kind-specific settings applied. */
const withSettings = (of: FieldType, field: FieldDraft): FieldType =>
  of.type === "enum"
    ? { ...of, values: choiceValues(field.values) }
    : of.type === "link"
      ? { ...of, to: field.to }
      : of;

/** `optional` and `description` on the outermost node, as the schema language puts them. */
const withCommon = (type: FieldType, field: FieldDraft): FieldType => {
  const { optional: _optional, description: _description, ...rest } = type;
  const description = field.description.trim();
  return {
    ...rest,
    ...(field.isRequired ? {} : { optional: true }),
    ...(String.isEmpty(description) ? {} : { description }),
  } as FieldType;
};

const stripCommon = (type: FieldType): FieldType => {
  const { optional: _optional, description: _description, ...rest } = type;
  return rest as FieldType;
};

/**
 * The definition a row describes. A row that keeps its stored kind starts
 * from the stored definition, so constraints the form doesn't show (patterns,
 * bounds, nullability) survive; a row whose kind changed starts fresh.
 */
export const nodeOf = (field: FieldDraft): FieldType =>
  withCommon(
    Option.match(
      Option.filter(field.maybeOriginal, (original) => kindOf(original) === field.kind),
      {
        onNone: () => freshNode(field),
        onSome: (original) =>
          original.type === "nullable"
            ? {
                ...original,
                of: withSettings(stripCommon(original.of), field),
              }
            : withSettings(original, field),
      },
    ),
    field,
  );

export const canBeTitle = (field: FieldDraft): boolean => titleKinds.has(field.kind);

const titleOf = (draft: TypeDraft): Option.Option<FieldDraft> =>
  Option.flatMap(draft.maybeTitleKey, (key) =>
    Array.findFirst(draft.fields, (field) => field.key === key),
  );

const label = (field: FieldDraft): string =>
  String.isEmpty(field.name.trim()) ? "A field" : field.name.trim();

/** What's wrong with the rows, before anything is sent. */
export const draftProblems = (draft: TypeDraft): ReadonlyArray<string> => {
  const names = Array.map(draft.fields, (field) => field.name.trim());
  const rowProblems = Array.flatMap(draft.fields, (field): ReadonlyArray<string> => {
    const name = field.name.trim();
    return [
      ...(String.isEmpty(name)
        ? ["Every field needs a name"]
        : isFieldName(name)
          ? []
          : [`${name}: field names use letters, digits and '_', and start with a letter or '_'`]),
      ...(Array.filter(names, (other) => other === name).length > 1 && String.isNonEmpty(name)
        ? [`More than one field is named ${name}`]
        : []),
      ...(field.kind === "link" && String.isEmpty(field.to)
        ? [`Choose the type ${label(field)} points to`]
        : []),
      ...(field.kind === "choice" && Array.isReadonlyArrayEmpty(choiceValues(field.values))
        ? [`Give ${label(field)} at least one choice`]
        : []),
    ];
  });
  const titleProblems = Option.match(titleOf(draft), {
    onNone: () => [],
    onSome: (field) =>
      canBeTitle(field) ? [] : [`${label(field)} can't be the title: a title is a text field`],
  });
  return Array.dedupe([
    ...(Array.isReadonlyArrayEmpty(draft.fields) ? ["A type needs at least one field"] : []),
    ...rowProblems,
    ...titleProblems,
  ]);
};

/** The schema a new type's rows describe, or what to fix first. */
export const schemaOf = (draft: TypeDraft): Result.Result<EntitySchema, ReadonlyArray<string>> => {
  const problems = draftProblems(draft);
  if (Array.isReadonlyArrayNonEmpty(problems)) {
    return Result.fail(problems);
  }
  const description = draft.description.trim();
  return Result.succeed({
    ...(String.isEmpty(description) ? {} : { description }),
    ...Option.match(titleOf(draft), {
      onNone: () => ({}),
      onSome: (field) => ({ title: field.name.trim() }),
    }),
    fields: Record.fromEntries(
      Array.map(draft.fields, (field) => [field.name.trim(), nodeOf(field)] as const),
    ),
  });
};

/** The rows as an edit of the version they were read from. */
export const editOf = (draft: TypeDraft): SchemaEdit => ({
  description: draft.description.trim(),
  title: Option.match(titleOf(draft), {
    onNone: () => undefined,
    onSome: (field) => field.name.trim(),
  }),
  fields: Array.map(draft.fields, (field): FieldEdit => ({
    name: field.name.trim(),
    from: Option.getOrUndefined(field.maybeOrigin),
    type: nodeOf(field),
  })),
});

/** The next version the rows describe, with its generated lens, or what to fix first. */
export const nextVersionOf = (
  current: EntitySchema,
  draft: TypeDraft,
): Result.Result<GeneratedVersion, ReadonlyArray<string>> => {
  const problems = draftProblems(draft);
  return Array.isReadonlyArrayNonEmpty(problems)
    ? Result.fail(problems)
    : generateVersion(current, editOf(draft));
};

/** A short description of a definition, for before/after rows. */
export const describeField = (type: FieldType): string => {
  const kind = kindOf(type);
  const of = inner(type);
  const base =
    of.type === "link"
      ? `Link to ${of.to}`
      : of.type === "enum"
        ? `Choice of ${of.values.join(", ")}`
        : kind === "other"
          ? of.type === "array"
            ? "List"
            : of.type === "object"
              ? "Object"
              : kindLabels[kind]
          : kindLabels[kind];
  return [
    base,
    type.optional === true ? "optional" : "required",
    ...(type.type === "nullable" ? ["can be null"] : []),
  ].join(", ");
};
