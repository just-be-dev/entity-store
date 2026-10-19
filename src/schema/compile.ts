import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";
import type { EntitySchema, FieldType } from "./model.ts";
import { isFieldName } from "./model.ts";

/** A problem with a schema definition, located by a dotted path. */
export interface DefinitionIssue {
  readonly path: string;
  readonly message: string;
}

const MAX_DEPTH = 10;
const MAX_PATTERN = 200;

/**
 * Patterns run on every write. Reject the classic catastrophic-backtracking
 * shape: a repeated group whose body starts with a quantified atom (`(a+)+`,
 * `(\\w*x)*`), so each repetition can steal input from the last. Separated
 * repeats like `[a-z]+(-[a-z]+)*` stay allowed. It's a heuristic, not a proof.
 */
const GROUP_STARTS_QUANTIFIED = /\((?:\?:)?(?:\\.|\[(?:\\.|[^\]\\])*\]|[^()|\\])[*+{]/;
const REPEATED_GROUP = /\)(?:[*+]|\{\d*,)/;

const patternProblem = (pattern: string): string | undefined => {
  if (pattern.length > MAX_PATTERN) {
    return `Patterns are limited to ${MAX_PATTERN} characters`;
  }
  try {
    new RegExp(pattern, "u");
  } catch {
    return `Invalid pattern: ${pattern}`;
  }
  if (GROUP_STARTS_QUANTIFIED.test(pattern) && REPEATED_GROUP.test(pattern)) {
    return "Pattern nests quantifiers (like (a+)+), which can backtrack catastrophically";
  }
  return undefined;
};
const MAX_FIELDS = 500;

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
      checkType(field, at, depth, true);
    }
  };

  const checkType = (type: FieldType, path: string, depth: number, isField: boolean) => {
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
        checkType(type.items, `${path}[]`, depth + 1, false);
        return;
      }
      case "object":
        checkFields(type.fields, path, depth + 1);
        return;
      case "nullable":
        if (type.of.type === "nullable") {
          issues.push({ path, message: "nullable of nullable is redundant" });
        }
        checkType(type.of, path, depth + 1, false);
        return;
      case "boolean":
      case "json":
        return;
    }
  };

  checkFields(schema.fields, "", 0);
  if (fieldCount > MAX_FIELDS) {
    issues.push({ path: "", message: `Schemas may define at most ${MAX_FIELDS} fields` });
  }
  return issues;
};

// Pragmatic format checks. They describe intent and catch obvious mistakes;
// they are not full RFC validators.
const FORMATS = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  url: /^https?:\/\/[^\s/$.?#].[^\s]*$/i,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  date: /^\d{4}-\d{2}-\d{2}$/,
  datetime: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/,
} as const;

/** A compiled entity schema: decodes JSON with no service requirements. */
export type DynamicSchema = Schema.Codec<unknown, unknown>;

const withChecks = <S extends Schema.Codec<any, any>>(
  schema: S,
  checks: ReadonlyArray<SchemaAST.Check<S["Type"]>>,
): DynamicSchema => {
  const [first, ...rest] = checks;
  return first === undefined ? schema : schema.check(first, ...rest);
};

const compileType = (type: FieldType): DynamicSchema => {
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
        checks.push(Schema.isPattern(new RegExp(type.pattern, "u")));
      }
      if (type.format !== undefined) {
        checks.push(
          Schema.isPattern(FORMATS[type.format], { message: `Expected a ${type.format}` }),
        );
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
      return withChecks(Schema.Array(compileType(type.items)), checks);
    }
    case "object":
      return compileFields(type.fields);
    case "nullable":
      return Schema.NullOr(compileType(type.of));
    case "json":
      return Schema.Json;
  }
};

const compileFields = (fields: { readonly [name: string]: FieldType }): DynamicSchema => {
  const struct: Record<string, DynamicSchema | Schema.optionalKey<DynamicSchema>> = {};
  for (const [name, field] of Object.entries(fields)) {
    const compiled = compileType(field);
    struct[name] = field.optional === true ? Schema.optionalKey(compiled) : compiled;
  }
  return Schema.Struct(struct);
};

/** Compile a (checked) entity schema into an Effect Schema for validation and sampling. */
export const compile = (schema: EntitySchema): DynamicSchema => compileFields(schema.fields);

/** A compiled schema plus a validator that rejects unknown fields. */
export interface CompiledSchema {
  readonly definition: EntitySchema;
  readonly schema: DynamicSchema;
  /** Validate data, returning the decoded value or a readable message. */
  readonly validate: (data: unknown) => Result.Result<unknown, string>;
}

export const compiled = (definition: EntitySchema): CompiledSchema => {
  const schema = compile(definition);
  const decode = Schema.decodeUnknownResult(schema);
  return {
    definition,
    schema,
    validate: (data) =>
      Result.mapError(
        decode(data, { errors: "all", onExcessProperty: "error" }),
        (error) => error.message,
      ),
  };
};
