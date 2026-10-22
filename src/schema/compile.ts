import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";
import type { EntitySchema, FieldType } from "./model.ts";
import { ENTITY_ID_PATTERN, TYPE_NAME_PATTERN, isFieldName } from "./model.ts";
import { compileRegex } from "./regex.ts";

/** A problem with a schema definition, located by a dotted path. */
export interface DefinitionIssue {
  readonly path: string;
  readonly message: string;
}

const MAX_DEPTH = 10;
const MAX_FIELDS = 500;
const MAX_PATTERN = 200;
/**
 * Lower bounds force the lens check to generate documents at least that big,
 * so they're capped to keep sampling within a Worker's memory.
 */
const MAX_MIN_LENGTH = 1000;
const MAX_MIN_ITEMS = 100;
const MAX_MIN_ITEMS_PRODUCT = 1000;

/**
 * Patterns run on every write and read, so they're matched with a linear-time
 * engine (`regex.ts`) instead of backtracking RegExp. A pattern must also be a
 * valid `u`-flag RegExp, because the lens check uses RegExp to generate samples.
 */
const patternProblem = (pattern: string): string | undefined => {
  if (pattern.length > MAX_PATTERN) {
    return `Patterns are limited to ${MAX_PATTERN} characters`;
  }
  const safe = compileRegex(pattern);
  if (Result.isFailure(safe)) {
    return `Unsupported pattern: ${safe.failure}`;
  }
  try {
    new RegExp(pattern, "u");
  } catch {
    return `Invalid pattern: ${pattern}`;
  }
  return undefined;
};

/**
 * Structural checks that the Schema decoder can't express: identifier field
 * names, sane bounds, compilable patterns, and size limits.
 */
export const checkDefinition = (schema: EntitySchema): ReadonlyArray<DefinitionIssue> => {
  const issues: Array<DefinitionIssue> = [];
  let fieldCount = 0;

  const checkFields = (
    fields: { readonly [name: string]: FieldType },
    path: string,
    depth: number,
    copies: number,
  ) => {
    for (const [name, field] of Object.entries(fields)) {
      fieldCount++;
      const at = path === "" ? name : `${path}.${name}`;
      if (!isFieldName(name)) {
        issues.push({
          path: at,
          message: "Field names must be identifiers (letters, digits, '_'), max 64 characters",
        });
      }
      checkType(field, at, depth, true, copies);
    }
  };

  /** `copies`: how many times enclosing arrays' minItems force this node to appear. */
  const checkType = (
    type: FieldType,
    path: string,
    depth: number,
    isField: boolean,
    copies: number,
  ) => {
    if (depth > MAX_DEPTH) {
      issues.push({ path, message: `Schemas may nest at most ${MAX_DEPTH} levels` });
      return;
    }
    if (!isField && type.optional !== undefined) {
      issues.push({ path, message: "'optional' only applies to object fields" });
    }
    switch (type.type) {
      case "string": {
        if (
          type.minLength !== undefined &&
          type.maxLength !== undefined &&
          type.minLength > type.maxLength
        ) {
          issues.push({ path, message: "minLength is greater than maxLength" });
        }
        if ((type.minLength ?? 0) > MAX_MIN_LENGTH) {
          issues.push({ path, message: `minLength is limited to ${MAX_MIN_LENGTH}` });
        }
        if (type.pattern !== undefined) {
          const problem = patternProblem(type.pattern);
          if (problem !== undefined) {
            issues.push({ path, message: problem });
          }
        }
        return;
      }
      case "number": {
        if (type.min !== undefined && type.max !== undefined && type.min > type.max) {
          issues.push({ path, message: "min is greater than max" });
        }
        return;
      }
      case "enum": {
        if (type.values.length === 0) {
          issues.push({ path, message: "An enum needs at least one value" });
        }
        if (new Set(type.values).size !== type.values.length) {
          issues.push({ path, message: "Enum values must be unique" });
        }
        return;
      }
      case "array": {
        if (
          type.minItems !== undefined &&
          type.maxItems !== undefined &&
          type.minItems > type.maxItems
        ) {
          issues.push({ path, message: "minItems is greater than maxItems" });
        }
        const minItems = type.minItems ?? 0;
        if (minItems > MAX_MIN_ITEMS) {
          issues.push({ path, message: `minItems is limited to ${MAX_MIN_ITEMS}` });
        }
        const nested = copies * Math.max(1, minItems);
        if (nested > MAX_MIN_ITEMS_PRODUCT) {
          issues.push({
            path,
            message: `Nested arrays may require at most ${MAX_MIN_ITEMS_PRODUCT} items in total`,
          });
        }
        checkType(type.items, `${path}[]`, depth + 1, false, nested);
        return;
      }
      case "object":
        checkFields(type.fields, path, depth + 1, copies);
        return;
      case "nullable":
        if (type.of.type === "nullable") {
          issues.push({ path, message: "nullable of nullable is redundant" });
        }
        checkType(type.of, path, depth + 1, false, copies);
        return;
      case "link":
        if (!TYPE_NAME_PATTERN.test(type.to)) {
          issues.push({ path, message: `'${type.to}' isn't a valid entity type name` });
        }
        return;
      case "boolean":
      case "json":
        return;
    }
  };

  checkFields(schema.fields, "", 0, 1);
  if (schema.title !== undefined) {
    const field = Object.hasOwn(schema.fields, schema.title)
      ? schema.fields[schema.title]
      : undefined;
    if (field === undefined) {
      issues.push({ path: "title", message: `'${schema.title}' isn't a top-level field` });
    } else if (
      field.type !== "string" &&
      !(field.type === "nullable" && field.of.type === "string")
    ) {
      issues.push({
        path: "title",
        message: `The title field must be a string or a nullable string, not ${field.type}`,
      });
    }
  }
  if (fieldCount > MAX_FIELDS) {
    issues.push({ path: "", message: `Schemas may define at most ${MAX_FIELDS} fields` });
  }
  return issues;
};

// Pragmatic format checks. They describe intent and catch obvious mistakes;
// they are not full RFC validators.
const FORMATS = {
  email: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
  url: "^[Hh][Tt][Tt][Pp][Ss]?://[^\\s/$.?#][^\\s]*$",
  uuid: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
  date: "^\\d{4}-\\d{2}-\\d{2}$",
  datetime: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:\\d{2})$",
} as const;

/**
 * Validation matches with the linear-time engine; sampling (the lens check)
 * uses RegExp so fast-check can generate matching strings.
 */
type Mode = "validate" | "sample";

const patternCheck = (source: string, mode: Mode, message?: string): SchemaAST.Check<string> => {
  const annotations = message === undefined ? undefined : { message };
  if (mode === "sample") {
    return Schema.isPattern(new RegExp(source, "u"), annotations);
  }
  const safe = compileRegex(source);
  // NOTE: definitions are checked before compiling, so this only fails for
  // stored schemas written before a pattern rule changed; treat them as no-match.
  const test = Result.isSuccess(safe) ? safe.success.test : () => false;
  return Schema.makeFilter(
    (value: string) => test(value) || (message ?? `Expected a string matching ${source}`),
    annotations,
  );
};

/** A compiled entity schema: decodes JSON with no service requirements. */
export type DynamicSchema = Schema.Codec<unknown, unknown>;

const withChecks = <S extends Schema.Codec<any, any>>(
  schema: S,
  checks: ReadonlyArray<SchemaAST.Check<S["Type"]>>,
): DynamicSchema => {
  const [first, ...rest] = checks;
  return first === undefined ? schema : schema.check(first, ...rest);
};

const compileType = (type: FieldType, mode: Mode): DynamicSchema => {
  switch (type.type) {
    case "string": {
      const checks: Array<SchemaAST.Check<string>> = [];
      if (type.minLength !== undefined) {
        checks.push(Schema.isMinLength(type.minLength));
      }
      if (type.maxLength !== undefined) {
        checks.push(Schema.isMaxLength(type.maxLength));
      }
      if (type.pattern !== undefined) {
        checks.push(patternCheck(type.pattern, mode));
      }
      if (type.format !== undefined) {
        checks.push(patternCheck(FORMATS[type.format], mode, `Expected a ${type.format}`));
      }
      return withChecks(Schema.String, checks);
    }
    case "number": {
      const checks: Array<SchemaAST.Check<number>> = [];
      if (type.integer === true) {
        checks.push(Schema.isInt());
      }
      if (type.min !== undefined) {
        checks.push(Schema.isGreaterThanOrEqualTo(type.min));
      }
      if (type.max !== undefined) {
        checks.push(Schema.isLessThanOrEqualTo(type.max));
      }
      return withChecks(Schema.Finite, checks);
    }
    case "boolean":
      return Schema.Boolean;
    case "enum":
      return Schema.Literals(type.values);
    case "array": {
      const checks: Array<SchemaAST.Check<ReadonlyArray<unknown>>> = [];
      if (type.minItems !== undefined) {
        checks.push(Schema.isMinLength(type.minItems));
      }
      if (type.maxItems !== undefined) {
        checks.push(Schema.isMaxLength(type.maxItems));
      }
      return withChecks(Schema.Array(compileType(type.items, mode)), checks);
    }
    case "object":
      return compileFields(type.fields, mode);
    case "nullable":
      return Schema.NullOr(compileType(type.of, mode));
    case "json":
      return Schema.Json;
    case "link":
      return withChecks(Schema.String, [
        patternCheck(ENTITY_ID_PATTERN, mode, `Expected the id of a ${type.to}`),
      ]);
  }
};

const compileFields = (
  fields: { readonly [name: string]: FieldType },
  mode: Mode,
): DynamicSchema => {
  const struct: Record<string, DynamicSchema | Schema.optionalKey<DynamicSchema>> = {};
  for (const [name, field] of Object.entries(fields)) {
    const compiled = compileType(field, mode);
    struct[name] = field.optional === true ? Schema.optionalKey(compiled) : compiled;
  }
  return Schema.Struct(struct);
};

/** Compile a (checked) entity schema into an Effect Schema for validation and sampling. */
export const compile = (schema: EntitySchema, mode: Mode = "validate"): DynamicSchema =>
  compileFields(schema.fields, mode);

/** A compiled schema plus a validator that rejects unknown fields. */
export interface CompiledSchema {
  readonly definition: EntitySchema;
  readonly schema: DynamicSchema;
  /** The same schema with RegExp patterns, for generating sample documents. */
  readonly sampling: () => DynamicSchema;
  /** Validate data, returning the decoded value or a readable message. */
  readonly validate: (data: unknown) => Result.Result<unknown, string>;
}

export const compiled = (definition: EntitySchema): CompiledSchema => {
  const schema = compile(definition);
  const decode = Schema.decodeUnknownResult(schema);
  return {
    definition,
    schema,
    sampling: () => compile(definition, "sample"),
    validate: (data) =>
      Result.mapError(
        decode(data, { errors: "all", onExcessProperty: "error" }),
        (error) => error.message,
      ),
  };
};
