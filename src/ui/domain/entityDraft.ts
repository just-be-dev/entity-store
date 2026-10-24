import * as Array from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as String from "effect/String";
import { defineTaggedUnion } from "foldkit/schema";
import { compiled } from "../../schema/compile.ts";
import {
  ENTITY_ID_PATTERN,
  type EntitySchema,
  type FieldType,
  isDotsOnly,
} from "../../schema/model.ts";
import { parseJson, prettyJson } from "./json.ts";

// Entity data as the entity form edits it: one typed input per top-level
// field, holding text, turned back into JSON and checked against the field's
// own definition before anything is sent. An empty input clears the field.

/** How a field is edited. */
export const InputKind = defineTaggedUnion({
  Text: { format: Schema.Literals(["plain", "email", "url"]) },
  Number: { isInteger: Schema.Boolean },
  Boolean: {},
  Date: {},
  DateTime: {},
  Choice: { values: Schema.Array(Schema.String) },
  Link: { to: Schema.String },
  Json: {},
});
export type InputKind = typeof InputKind.Type;

export interface FormField {
  readonly name: string;
  readonly label: string;
  readonly input: InputKind;
  readonly isRequired: boolean;
  readonly type: FieldType;
}

const inner = (type: FieldType): FieldType => (type.type === "nullable" ? inner(type.of) : type);

const inputOf = (type: FieldType): InputKind => {
  const of = inner(type);
  switch (of.type) {
    case "string":
      return of.format === "date"
        ? InputKind.Date()
        : of.format === "datetime"
          ? InputKind.DateTime()
          : InputKind.Text({
              format: of.format === "email" ? "email" : of.format === "url" ? "url" : "plain",
            });
    case "number":
      return InputKind.Number({ isInteger: of.integer === true });
    case "boolean":
      return InputKind.Boolean();
    case "enum":
      return InputKind.Choice({ values: of.values });
    case "link":
      return InputKind.Link({ to: of.to });
    default:
      return InputKind.Json();
  }
};

/** The form's inputs for a schema version, in field order. */
export const formFields = (schema: EntitySchema): ReadonlyArray<FormField> =>
  Array.map(Record.toEntries(schema.fields), ([name, type]) => ({
    name,
    label: type.description ?? inner(type).description ?? name,
    input: inputOf(type),
    isRequired: type.optional !== true,
    type,
  }));

const pad = (value: number, width = 2) => `${value}`.padStart(width, "0");

/** `YYYY-MM-DDTHH:MM:SS` in UTC, as a `datetime-local` input shows it. */
const utcInputText = (iso: string): Option.Option<string> =>
  Option.map(DateTime.make(iso), (dateTime) => {
    const parts = DateTime.toPartsUtc(dateTime);
    return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
  });

/** A stored value as its input's text. Absent and `null` are empty. */
export const textOf = (field: FormField, value: unknown): string => {
  if (value === undefined || value === null) {
    return "";
  }
  const json = () => prettyJson(value as Schema.Json);
  const asString = () => (typeof value === "string" ? value : json());
  return InputKind.match(field.input, {
    Text: asString,
    Date: asString,
    Choice: asString,
    Link: asString,
    DateTime: () =>
      typeof value === "string" ? Option.getOrElse(utcInputText(value), () => value) : json(),
    Number: () => (typeof value === "number" ? `${value}` : json()),
    Boolean: () => (value === true ? "true" : value === false ? "false" : json()),
    Json: json,
  });
};

const hasSeconds = /T\d{2}:\d{2}:\d{2}/;

/** An input's text as a value, before its definition is checked. Empty is none. */
const parse = (
  field: FormField,
  text: string,
): Result.Result<Option.Option<Schema.Json>, string> => {
  const trimmed = text.trim();
  if (String.isEmpty(trimmed)) {
    return Result.succeed(Option.none());
  }
  const some = (value: Schema.Json) => Result.succeed(Option.some(value));
  return InputKind.match<Result.Result<Option.Option<Schema.Json>, string>>(field.input, {
    Text: () => some(text),
    Link: () => some(trimmed),
    Choice: () => some(trimmed),
    Date: () => some(trimmed),
    DateTime: () =>
      some(
        /(Z|[+-]\d{2}:\d{2})$/.test(trimmed)
          ? trimmed
          : `${trimmed}${hasSeconds.test(trimmed) ? "" : ":00"}Z`,
      ),
    Number: ({ isInteger }) => {
      const value = Number(trimmed);
      return Number.isFinite(value)
        ? some(value)
        : Result.fail(isInteger ? "Enter a whole number" : "Enter a number");
    },
    Boolean: () =>
      trimmed === "true"
        ? some(true)
        : trimmed === "false"
          ? some(false)
          : Result.fail("Choose yes or no"),
    Json: () =>
      Result.match(parseJson(text), {
        onFailure: (message) => Result.fail(`Not valid JSON: ${message}`),
        onSuccess: some,
      }),
  });
};

const checkValue = (field: FormField, value: Schema.Json): Result.Result<Schema.Json, string> =>
  Result.map(
    compiled({ fields: { [field.name]: { ...field.type, optional: true } } }).validate({
      [field.name]: value,
    }),
    () => value,
  );

/** One input's value: none when empty, or why it can't be saved. */
export const valueOf = (
  field: FormField,
  text: string,
): Result.Result<Option.Option<Schema.Json>, string> =>
  Result.flatMap(parse(field, text), (maybeValue) =>
    Option.match(maybeValue, {
      onNone: () =>
        field.isRequired ? Result.fail("Required") : Result.succeed(Option.none<Schema.Json>()),
      onSome: (value) => Result.map(checkValue(field, value), Option.some),
    }),
  );

export interface FieldError {
  readonly field: string;
  readonly message: string;
}

/**
 * The merge patch a form describes: for a new entity, every filled input;
 * for an existing one, only inputs whose text changed, with `null` for an
 * input that was emptied, which clears the field.
 */
export const patchOf = (
  fields: ReadonlyArray<FormField>,
  values: Readonly<Record<string, string>>,
  initial: Readonly<Record<string, string>>,
  mode: "create" | "edit",
): Result.Result<Readonly<Record<string, Schema.Json>>, ReadonlyArray<FieldError>> => {
  const results = Array.map(fields, (field) => {
    const text = values[field.name] ?? "";
    const changed = text !== (initial[field.name] ?? "");
    return {
      field,
      changed,
      result:
        mode === "edit" && !changed && !String.isEmpty(text.trim())
          ? Result.succeed(Option.none<Schema.Json>())
          : valueOf(field, text),
    };
  });
  const errors = Array.filterMap(results, ({ field, result }) =>
    Result.match(result, {
      onFailure: (message) => Result.succeed({ field: field.name, message }),
      onSuccess: () => Result.failVoid,
    }),
  );
  if (Array.isReadonlyArrayNonEmpty(errors)) {
    return Result.fail(errors);
  }
  return Result.succeed(
    Record.fromEntries(
      Array.filterMap(results, ({ field, changed, result }) =>
        Result.match(result, {
          onFailure: () => Result.failVoid,
          onSuccess: (maybeValue) =>
            Option.match(maybeValue, {
              onNone: () =>
                mode === "edit" && changed
                  ? Result.succeed([field.name, null] as const)
                  : Result.failVoid,
              onSome: (value) =>
                mode === "create" || changed
                  ? Result.succeed([field.name, value] as const)
                  : Result.failVoid,
            }),
        }),
      ),
    ),
  );
};

/** Every input's text for stored data. */
export const textsOf = (
  fields: ReadonlyArray<FormField>,
  data: unknown,
): Readonly<Record<string, string>> =>
  Record.fromEntries(
    Array.map(fields, (field) => [
      field.name,
      textOf(
        field,
        typeof data === "object" && data !== null && !globalThis.Array.isArray(data)
          ? (data as Readonly<Record<string, unknown>>)[field.name]
          : undefined,
      ),
    ]),
  );

const idPattern = new RegExp(ENTITY_ID_PATTERN);

/** Why an entity id can't be used, if it can't. */
export const idProblem = (id: string): Option.Option<string> =>
  idPattern.test(id) && !isDotsOnly(id)
    ? Option.none()
    : Option.some(
        "IDs use letters, digits, '_', '-', '.' and '@' (up to 128), and aren't only dots",
      );

/** A value as one table cell's text. */
export const cellText = (field: FormField, value: unknown): string =>
  value === undefined || value === null
    ? ""
    : field.input._tag === "Boolean" && typeof value === "boolean"
      ? value
        ? "Yes"
        : "No"
      : field.input._tag === "Json"
        ? JSON.stringify(value)
        : textOf(field, value);
