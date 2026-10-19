import * as Result from "effect/Result";
import { isFieldName } from "../schema/model.ts";
import type { Expr, Json, JsonObject, Value } from "./expr.ts";
import { ExprError, jsonEquals, parse, run } from "./expr.ts";
import type { Direction, Lens, LensOp } from "./model.ts";

/** A problem with a lens definition, located by op path like `ops[2].ops[0]`. */
export interface LensIssue {
  readonly path: string;
  readonly message: string;
}

/** A lens that has been checked and had its expressions parsed. */
export interface CompiledLens {
  readonly definition: Lens;
  readonly forward: (doc: unknown) => Result.Result<JsonObject, string>;
  readonly backward: (doc: unknown) => Result.Result<JsonObject, string>;
}

type Step = (doc: JsonObject) => JsonObject;
interface CompiledOp {
  readonly forward: Step;
  readonly backward: Step;
}

const isObject = (v: unknown): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const has = (doc: JsonObject, key: string) => Object.hasOwn(doc, key) && doc[key] !== undefined;

/** Copy-on-write field update that can't touch prototypes. */
const withField = (doc: JsonObject, key: string, value: Value): JsonObject => {
  const copy: Record<string, Json> = { ...doc };
  if (value === undefined) {
    delete copy[key];
  } else {
    Object.defineProperty(copy, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return copy;
};

const without = (doc: JsonObject, key: string): JsonObject =>
  has(doc, key) ? withField(doc, key, undefined) : doc;

class LensRuntimeError extends Error {
  override readonly name = "LensRuntimeError";
}

const rename = (from: string, to: string): Step => (doc) =>
  has(doc, from) ? withField(without(doc, from), to, doc[from]) : doc;

const add = (field: string, value: Json | undefined): Step => (doc) =>
  has(doc, field) || value === undefined ? doc : withField(doc, field, value);

const remove = (field: string): Step => (doc) => without(doc, field);

const convert =
  (field: string, pairs: ReadonlyArray<readonly [Json, Json]>, fallback: Json | undefined): Step =>
  (doc) => {
    if (!has(doc, field)) {
      return doc;
    }
    const value = doc[field];
    const match = pairs.find(([from]) => jsonEquals(from, value));
    if (match !== undefined) {
      return withField(doc, field, match[1]);
    }
    if (fallback !== undefined) {
      return withField(doc, field, fallback);
    }
    throw new LensRuntimeError(
      `convert: no mapping for ${field} = ${JSON.stringify(value)} and no fallback`,
    );
  };

const inside =
  (field: string, step: Step): Step =>
  (doc) => {
    const value = doc[field];
    return has(doc, field) && isObject(value) ? withField(doc, field, step(value)) : doc;
  };

const each =
  (field: string, step: Step): Step =>
  (doc) => {
    const value = doc[field];
    if (!has(doc, field) || !Array.isArray(value)) {
      return doc;
    }
    return withField(
      doc,
      field,
      value.map((item: Json) => (isObject(item) ? step(item) : item)),
    );
  };

const hoist =
  (host: string, field: string): Step =>
  (doc) => {
    const inner = doc[host];
    if (!has(doc, host) || !isObject(inner) || !has(inner, field)) {
      return doc;
    }
    // NOTE: a host left empty is dropped, so hoist exactly undoes a plunge that created it.
    const rest = without(inner, field);
    const next = Object.keys(rest).length === 0 ? without(doc, host) : withField(doc, host, rest);
    return withField(next, field, inner[field]);
  };

const plunge =
  (host: string, field: string): Step =>
  (doc) => {
    if (!has(doc, field)) {
      return doc;
    }
    const existing = doc[host];
    const inner = isObject(existing) ? existing : {};
    return withField(without(doc, field), host, withField(inner, field, doc[field]));
  };

/**
 * Compute `produce` from the input document, then drop the fields that the
 * opposite direction produces (they're being replaced), unless also produced.
 */
const derive =
  (produce: ReadonlyArray<readonly [string, Expr]>, replaces: ReadonlyArray<string>): Step =>
  (doc) => {
    const computed = produce.map(([field, expr]) => {
      try {
        return [field, run(expr, doc)] as const;
      } catch (error) {
        throw new LensRuntimeError(
          `derive ${field}: ${error instanceof ExprError ? error.message : String(error)}`,
        );
      }
    });
    const produced = new Set(produce.map(([field]) => field));
    let out = doc;
    for (const field of replaces) {
      if (!produced.has(field)) {
        out = without(out, field);
      }
    }
    for (const [field, value] of computed) {
      out = withField(out, field, value);
    }
    return out;
  };

const compose =
  (steps: ReadonlyArray<Step>): Step =>
  (doc) =>
    steps.reduce((acc, step) => step(acc), doc);

const compileOps = (
  ops: ReadonlyArray<LensOp>,
  path: string,
  issues: Array<LensIssue>,
): CompiledOp => {
  const compiled = ops.map((op, index) => compileOp(op, `${path}[${index}]`, issues));
  return {
    forward: compose(compiled.map((c) => c.forward)),
    backward: compose(compiled.map((c) => c.backward).reverse()),
  };
};

const identity: CompiledOp = { forward: (doc) => doc, backward: (doc) => doc };

const compileOp = (op: LensOp, path: string, issues: Array<LensIssue>): CompiledOp => {
  const field = (name: string, label: string) => {
    if (!isFieldName(name)) {
      issues.push({ path, message: `${label} '${name}' is not a valid field name` });
    }
  };
  switch (op.op) {
    case "rename":
      field(op.from, "from");
      field(op.to, "to");
      if (op.from === op.to) {
        issues.push({ path, message: "rename from and to are the same field" });
      }
      return { forward: rename(op.from, op.to), backward: rename(op.to, op.from) };
    case "add":
      field(op.field, "field");
      return { forward: add(op.field, op.default), backward: remove(op.field) };
    case "remove":
      field(op.field, "field");
      return { forward: remove(op.field), backward: add(op.field, op.default) };
    case "convert": {
      field(op.field, "field");
      const inverse = op.mapping.map(([a, b]) => [b, a] as const);
      return {
        forward: convert(op.field, op.mapping, op.fallback?.forward),
        backward: convert(op.field, inverse, op.fallback?.backward),
      };
    }
    case "in": {
      field(op.field, "field");
      const inner = compileOps(op.ops, `${path}.ops`, issues);
      return {
        forward: inside(op.field, inner.forward),
        backward: inside(op.field, inner.backward),
      };
    }
    case "each": {
      field(op.field, "field");
      const inner = compileOps(op.ops, `${path}.ops`, issues);
      return { forward: each(op.field, inner.forward), backward: each(op.field, inner.backward) };
    }
    case "hoist":
      field(op.host, "host");
      field(op.field, "field");
      return { forward: hoist(op.host, op.field), backward: plunge(op.host, op.field) };
    case "plunge":
      field(op.host, "host");
      field(op.field, "field");
      return { forward: plunge(op.host, op.field), backward: hoist(op.host, op.field) };
    case "derive": {
      const parseAll = (exprs: { readonly [field: string]: string }, label: Direction) =>
        Object.entries(exprs).flatMap(([name, source]) => {
          field(name, `${label} field`);
          const parsed = parse(source);
          if (Result.isFailure(parsed)) {
            issues.push({ path: `${path}.${label}.${name}`, message: parsed.failure });
            return [];
          }
          return [[name, parsed.success] as const];
        });
      const forward = parseAll(op.forward, "forward");
      const backward = parseAll(op.backward, "backward");
      if (Object.keys(op.forward).length === 0 && Object.keys(op.backward).length === 0) {
        issues.push({ path, message: "derive needs at least one forward or backward field" });
        return identity;
      }
      return {
        forward: derive(forward, Object.keys(op.backward)),
        backward: derive(backward, Object.keys(op.forward)),
      };
    }
  }
};

const MAX_OPS = 200;

const countOps = (ops: ReadonlyArray<LensOp>): number =>
  ops.reduce((n, op) => n + 1 + (op.op === "in" || op.op === "each" ? countOps(op.ops) : 0), 0);

/** Check a lens definition and compile it, or return every problem found. */
export const compileLens = (
  definition: Lens,
): Result.Result<CompiledLens, ReadonlyArray<LensIssue>> => {
  const issues: Array<LensIssue> = [];
  if (countOps(definition.ops) > MAX_OPS) {
    issues.push({ path: "ops", message: `A lens may contain at most ${MAX_OPS} ops` });
  }
  const compiled = compileOps(definition.ops, "ops", issues);
  if (issues.length > 0) {
    return Result.fail(issues);
  }
  const runStep =
    (step: Step) =>
    (doc: unknown): Result.Result<JsonObject, string> => {
      if (!isObject(doc as Value)) {
        return Result.fail("Lens input must be an object");
      }
      try {
        return Result.succeed(step(doc as JsonObject));
      } catch (error) {
        return Result.fail(error instanceof Error ? error.message : String(error));
      }
    };
  return Result.succeed({
    definition,
    forward: runStep(compiled.forward),
    backward: runStep(compiled.backward),
  });
};
