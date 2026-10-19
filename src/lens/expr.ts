import * as Result from "effect/Result";

/**
 * A small, pure expression language for lens transforms.
 *
 * It is deliberately not JavaScript: no loops, no I/O, no clock, no globals, so
 * every expression terminates, is deterministic, and is safe to run in the API
 * Worker on every read. Identifiers refer to fields of the document being
 * transformed (`$` is the whole document).
 *
 *   firstName + " " + lastName
 *   split(fullName, " ")[0]
 *   status == "done" ? "closed" : "open"
 *   map(tags, t => lower(trim(t)))
 *   price ?? 0
 */

export type Json = null | boolean | number | string | ReadonlyArray<Json> | JsonObject;
export interface JsonObject {
  readonly [key: string]: Json;
}
/** Expression values: JSON plus `undefined` for "absent". */
export type Value = Json | undefined;

export type Expr =
  | { readonly k: "lit"; readonly v: Json }
  | { readonly k: "var"; readonly name: string }
  | { readonly k: "get"; readonly obj: Expr; readonly key: Expr }
  | { readonly k: "call"; readonly fn: string; readonly args: ReadonlyArray<Expr | Lambda> }
  | { readonly k: "unary"; readonly op: "!" | "-"; readonly e: Expr }
  | { readonly k: "bin"; readonly op: BinOp; readonly l: Expr; readonly r: Expr }
  | { readonly k: "cond"; readonly c: Expr; readonly t: Expr; readonly f: Expr }
  | { readonly k: "arr"; readonly items: ReadonlyArray<Expr> }
  | { readonly k: "obj"; readonly entries: ReadonlyArray<readonly [string, Expr]> };

export interface Lambda {
  readonly k: "lambda";
  readonly param: string;
  readonly body: Expr;
}

type BinOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "&&"
  | "||"
  | "??";

export class ExprError extends Error {
  override readonly name = "ExprError";
}

const MAX_SOURCE = 4000;

// ─── Tokenizer ──────────────────────────────────────────────────────────────

type Token =
  | { readonly t: "num"; readonly v: number; readonly pos: number }
  | { readonly t: "str"; readonly v: string; readonly pos: number }
  | { readonly t: "ident"; readonly v: string; readonly pos: number }
  | { readonly t: "punct"; readonly v: string; readonly pos: number }
  | { readonly t: "eof"; readonly pos: number };

const PUNCT = [
  "=>",
  "??",
  "||",
  "&&",
  "==",
  "!=",
  "<=",
  ">=",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  ",",
  ".",
  ":",
  "?",
  "<",
  ">",
  "+",
  "-",
  "*",
  "/",
  "%",
  "!",
];

const tokenize = (src: string): Array<Token> => {
  const tokens: Array<Token> = [];
  let i = 0;
  while (i < src.length) {
    const c = src.charAt(i);
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(src.slice(i));
      const text = m?.[0] ?? c;
      tokens.push({ t: "num", v: Number(text), pos: i });
      i += text.length;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i));
      const text = m?.[0] ?? c;
      tokens.push({ t: "ident", v: text, pos: i });
      i += text.length;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      i++;
      let out = "";
      while (i < src.length && src.charAt(i) !== c) {
        const ch = src.charAt(i);
        if (ch === "\\") {
          const next = src.charAt(i + 1);
          const escapes: Record<string, string> = {
            n: "\n",
            t: "\t",
            r: "\r",
            "\\": "\\",
            "'": "'",
            '"': '"',
          };
          if (next === "u") {
            const hex = src.slice(i + 2, i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              throw new ExprError(`Invalid unicode escape at ${i}`);
            }
            out += String.fromCharCode(parseInt(hex, 16));
            i += 6;
            continue;
          }
          const escaped = escapes[next];
          if (escaped === undefined) {
            throw new ExprError(`Invalid escape \\${next} at ${i}`);
          }
          out += escaped;
          i += 2;
          continue;
        }
        out += ch;
        i++;
      }
      if (i >= src.length) {
        throw new ExprError(`Unterminated string starting at ${start}`);
      }
      i++;
      tokens.push({ t: "str", v: out, pos: start });
      continue;
    }
    const punct = PUNCT.find((p) => src.startsWith(p, i));
    if (punct === undefined) {
      throw new ExprError(`Unexpected character '${c}' at ${i}`);
    }
    tokens.push({ t: "punct", v: punct, pos: i });
    i += punct.length;
  }
  tokens.push({ t: "eof", pos: src.length });
  return tokens;
};

// ─── Parser (precedence climbing) ───────────────────────────────────────────

const BINARY_LEVELS: ReadonlyArray<ReadonlyArray<BinOp>> = [
  ["??"],
  ["||"],
  ["&&"],
  ["==", "!="],
  ["<", "<=", ">", ">="],
  ["+", "-"],
  ["*", "/", "%"],
];

const LITERAL_IDENTS: Record<string, Json> = { true: true, false: false, null: null };

class Parser {
  private i = 0;
  constructor(private readonly tokens: ReadonlyArray<Token>) {}

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.i + offset, this.tokens.length - 1)] ?? { t: "eof", pos: 0 };
  }
  private next(): Token {
    const token = this.peek();
    this.i++;
    return token;
  }
  private isPunct(v: string, offset = 0) {
    const token = this.peek(offset);
    return token.t === "punct" && token.v === v;
  }
  private expect(v: string) {
    const token = this.next();
    if (token.t !== "punct" || token.v !== v) {
      throw new ExprError(`Expected '${v}' at ${token.pos}`);
    }
  }

  parseProgram(): Expr {
    const e = this.parseExpr();
    const token = this.peek();
    if (token.t !== "eof") {
      throw new ExprError(`Unexpected input at ${token.pos}`);
    }
    return e;
  }

  parseExpr(): Expr {
    const c = this.parseBinary(0);
    if (this.isPunct("?")) {
      this.next();
      const t = this.parseExpr();
      this.expect(":");
      const f = this.parseExpr();
      return { k: "cond", c, t, f };
    }
    return c;
  }

  private parseBinary(level: number): Expr {
    const ops = BINARY_LEVELS[level];
    if (ops === undefined) {
      return this.parseUnary();
    }
    let left = this.parseBinary(level + 1);
    for (;;) {
      const token = this.peek();
      const op = token.t === "punct" ? ops.find((o) => o === token.v) : undefined;
      if (op === undefined) {
        return left;
      }
      this.next();
      const right = this.parseBinary(level + 1);
      left = { k: "bin", op, l: left, r: right };
    }
  }

  private parseUnary(): Expr {
    if (this.isPunct("!") || this.isPunct("-")) {
      const op = this.next();
      const e = this.parseUnary();
      return { k: "unary", op: op.t === "punct" && op.v === "-" ? "-" : "!", e };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let e = this.parsePrimary();
    for (;;) {
      if (this.isPunct(".")) {
        this.next();
        const name = this.next();
        if (name.t !== "ident") {
          throw new ExprError(`Expected a field name at ${name.pos}`);
        }
        e = { k: "get", obj: e, key: { k: "lit", v: name.v } };
      } else if (this.isPunct("[")) {
        this.next();
        const key = this.parseExpr();
        this.expect("]");
        e = { k: "get", obj: e, key };
      } else {
        return e;
      }
    }
  }

  private parseArg(): Expr | Lambda {
    const token = this.peek();
    if (token.t === "ident" && this.isPunct("=>", 1)) {
      this.next();
      this.next();
      return { k: "lambda", param: token.v, body: this.parseExpr() };
    }
    return this.parseExpr();
  }

  private parsePrimary(): Expr {
    const token = this.next();
    switch (token.t) {
      case "num":
        return { k: "lit", v: token.v };
      case "str":
        return { k: "lit", v: token.v };
      case "ident": {
        if (Object.hasOwn(LITERAL_IDENTS, token.v)) {
          return { k: "lit", v: LITERAL_IDENTS[token.v] ?? null };
        }
        if (this.isPunct("(")) {
          this.next();
          const args: Array<Expr | Lambda> = [];
          if (!this.isPunct(")")) {
            args.push(this.parseArg());
            while (this.isPunct(",")) {
              this.next();
              args.push(this.parseArg());
            }
          }
          this.expect(")");
          const builtin = BUILTINS[token.v];
          if (builtin === undefined || !Object.hasOwn(BUILTINS, token.v)) {
            throw new ExprError(`Unknown function '${token.v}' at ${token.pos}`);
          }
          if (args.length < builtin.min || args.length > builtin.max) {
            throw new ExprError(
              `${token.v}() takes ${builtin.min === builtin.max ? builtin.min : `${builtin.min}-${builtin.max === Infinity ? "n" : builtin.max}`} argument(s), got ${args.length}`,
            );
          }
          args.forEach((arg, index) => {
            const wantsLambda = builtin.lambdaArg === index;
            if (wantsLambda !== (arg.k === "lambda")) {
              throw new ExprError(
                wantsLambda
                  ? `${token.v}() expects a function like 'x => ...' as argument ${index + 1}`
                  : `Unexpected function argument to ${token.v}()`,
              );
            }
          });
          return { k: "call", fn: token.v, args };
        }
        return { k: "var", name: token.v };
      }
      case "punct": {
        if (token.v === "(") {
          const e = this.parseExpr();
          this.expect(")");
          return e;
        }
        if (token.v === "[") {
          const items: Array<Expr> = [];
          if (!this.isPunct("]")) {
            items.push(this.parseExpr());
            while (this.isPunct(",")) {
              this.next();
              items.push(this.parseExpr());
            }
          }
          this.expect("]");
          return { k: "arr", items };
        }
        if (token.v === "{") {
          const entries: Array<readonly [string, Expr]> = [];
          if (!this.isPunct("}")) {
            do {
              if (entries.length > 0) {
                this.next();
              }
              const key = this.next();
              if (key.t !== "ident" && key.t !== "str") {
                throw new ExprError(`Expected a key at ${key.pos}`);
              }
              if (this.isPunct(":")) {
                this.next();
                entries.push([key.v, this.parseExpr()]);
              } else if (key.t === "ident") {
                entries.push([key.v, { k: "var", name: key.v }]);
              } else {
                throw new ExprError(`Expected ':' at ${key.pos}`);
              }
            } while (this.isPunct(","));
          }
          this.expect("}");
          return { k: "obj", entries };
        }
        throw new ExprError(`Unexpected '${token.v}' at ${token.pos}`);
      }
      case "eof":
        throw new ExprError("Unexpected end of expression");
    }
  }
}

export const parse = (source: string): Result.Result<Expr, string> => {
  if (source.length > MAX_SOURCE) {
    return Result.fail(`Expressions are limited to ${MAX_SOURCE} characters`);
  }
  try {
    return Result.succeed(new Parser(tokenize(source)).parseProgram());
  } catch (error) {
    return Result.fail(error instanceof Error ? error.message : String(error));
  }
};

// ─── Evaluation ─────────────────────────────────────────────────────────────

const typeOf = (v: Value) =>
  v === undefined
    ? "undefined"
    : v === null
      ? "null"
      : Array.isArray(v)
        ? "array"
        : (typeof v as "string" | "number" | "boolean" | "object");

const isObject = (v: Value): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const truthy = (v: Value) => !(v === undefined || v === null || v === false || v === 0 || v === "");

export const jsonEquals = (a: Value, b: Value): boolean => {
  if (a === b) {
    return true;
  }
  if ((a === undefined || a === null) && (b === undefined || b === null)) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => jsonEquals(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return (
      ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && jsonEquals(a[k], b[k]))
    );
  }
  return false;
};

const num = (fn: string, v: Value): number => {
  if (typeof v !== "number") {
    throw new ExprError(`${fn} expects a number, got ${typeOf(v)}`);
  }
  return v;
};
const str = (fn: string, v: Value): string => {
  if (typeof v !== "string") {
    throw new ExprError(`${fn} expects a string, got ${typeOf(v)}`);
  }
  return v;
};
const arr = (fn: string, v: Value): ReadonlyArray<Json> => {
  if (!Array.isArray(v)) {
    throw new ExprError(`${fn} expects an array, got ${typeOf(v)}`);
  }
  return v;
};
const obj = (fn: string, v: Value): JsonObject => {
  if (!isObject(v)) {
    throw new ExprError(`${fn} expects an object, got ${typeOf(v)}`);
  }
  return v;
};
const finite = (n: number): number => {
  if (!Number.isFinite(n)) {
    throw new ExprError("Arithmetic produced a non-finite number");
  }
  return n;
};
/** Arrays can't hold `undefined`; absent values become null, as in JSON. */
const toJson = (v: Value): Json => (v === undefined ? null : v);

const stringify = (v: Value): string | undefined =>
  v === undefined
    ? undefined
    : typeof v === "string"
      ? v
      : typeof v === "number" || typeof v === "boolean" || v === null
        ? String(v)
        : JSON.stringify(v);

type Call = (fn: string, args: ReadonlyArray<Value>, lambda?: (v: Value) => Value) => Value;

interface Builtin {
  readonly min: number;
  readonly max: number;
  readonly lambdaArg?: number;
  readonly call: Call;
  readonly doc: string;
}

const builtin = (min: number, max: number, doc: string, call: Call, lambdaArg?: number): Builtin =>
  lambdaArg === undefined ? { min, max, doc, call } : { min, max, doc, call, lambdaArg };

const sliceable = (fn: string, v: Value) => {
  if (typeof v === "string" || Array.isArray(v)) {
    return v;
  }
  throw new ExprError(`${fn} expects a string or array, got ${typeOf(v)}`);
};

export const BUILTINS: Readonly<Record<string, Builtin>> = {
  string: builtin(1, 1, "Convert to a string", (_, [v]) => stringify(v)),
  number: builtin(1, 1, "Convert a string or boolean to a number", (fn, [v]) => {
    if (v === undefined || v === null) {
      return v;
    }
    const n = typeof v === "boolean" ? (v ? 1 : 0) : Number(typeof v === "string" ? v.trim() : v);
    if (
      typeof v === "object" ||
      (typeof v === "string" && v.trim() === "") ||
      !Number.isFinite(n)
    ) {
      throw new ExprError(`${fn} can't convert ${JSON.stringify(v)} to a number`);
    }
    return n;
  }),
  int: builtin(1, 1, "Truncate to an integer", (fn, [v]) =>
    v === undefined || v === null ? v : Math.trunc(num(fn, v)),
  ),
  boolean: builtin(1, 1, "Truthiness of a value", (_, [v]) => truthy(v)),
  lower: builtin(1, 1, "Lowercase a string", (fn, [v]) => str(fn, v).toLowerCase()),
  upper: builtin(1, 1, "Uppercase a string", (fn, [v]) => str(fn, v).toUpperCase()),
  trim: builtin(1, 1, "Trim whitespace", (fn, [v]) => str(fn, v).trim()),
  split: builtin(2, 2, "Split a string by a separator", (fn, [s, sep]) =>
    str(fn, s).split(str(fn, sep)),
  ),
  join: builtin(1, 2, "Join an array of strings", (fn, [a, sep]) =>
    arr(fn, a)
      .map((x) => stringify(x) ?? "")
      .join(sep === undefined ? "" : str(fn, sep)),
  ),
  replace: builtin(3, 3, "Replace every occurrence of a substring", (fn, [s, find, repl]) =>
    str(fn, s).split(str(fn, find)).join(str(fn, repl)),
  ),
  slice: builtin(2, 3, "Slice a string or array", (fn, [v, start, end]) =>
    sliceable(fn, v).slice(num(fn, start), end === undefined ? undefined : num(fn, end)),
  ),
  length: builtin(1, 1, "Length of a string, array, or object", (fn, [v]) => {
    if (isObject(v)) {
      return Object.keys(v).length;
    }
    return sliceable(fn, v).length;
  }),
  at: builtin(2, 2, "Element at an index (negative counts from the end)", (fn, [v, i]) => {
    const x = sliceable(fn, v).at(num(fn, i));
    return x === undefined ? undefined : x;
  }),
  first: builtin(1, 1, "First element", (fn, [v]) => sliceable(fn, v).at(0)),
  last: builtin(1, 1, "Last element", (fn, [v]) => sliceable(fn, v).at(-1)),
  includes: builtin(2, 2, "Whether a string/array contains a value", (fn, [v, x]) =>
    typeof v === "string" ? v.includes(str(fn, x)) : arr(fn, v).some((y) => jsonEquals(y, x)),
  ),
  startsWith: builtin(2, 2, "String prefix test", (fn, [s, p]) =>
    str(fn, s).startsWith(str(fn, p)),
  ),
  endsWith: builtin(2, 2, "String suffix test", (fn, [s, p]) => str(fn, s).endsWith(str(fn, p))),
  concat: builtin(1, Infinity, "Concatenate strings or arrays", (fn, args) => {
    if (args.every((a) => Array.isArray(a))) {
      return args.flatMap((a) => arr(fn, a));
    }
    return args.map((a) => stringify(a) ?? "").join("");
  }),
  coalesce: builtin(1, Infinity, "First value that isn't null or absent", (_, args) =>
    args.find((a) => a !== undefined && a !== null),
  ),
  exists: builtin(
    1,
    1,
    "Whether a value is present and not null",
    (_, [v]) => v !== undefined && v !== null,
  ),
  typeOf: builtin(1, 1, "Type name of a value", (_, [v]) => typeOf(v)),
  round: builtin(1, 2, "Round to n digits", (fn, [v, digits]) => {
    const d = digits === undefined ? 0 : num(fn, digits);
    const f = 10 ** d;
    return finite(Math.round(num(fn, v) * f) / f);
  }),
  floor: builtin(1, 1, "Round down", (fn, [v]) => Math.floor(num(fn, v))),
  ceil: builtin(1, 1, "Round up", (fn, [v]) => Math.ceil(num(fn, v))),
  abs: builtin(1, 1, "Absolute value", (fn, [v]) => Math.abs(num(fn, v))),
  min: builtin(1, Infinity, "Smallest number", (fn, args) =>
    Math.min(...args.map((a) => num(fn, a))),
  ),
  max: builtin(1, Infinity, "Largest number", (fn, args) =>
    Math.max(...args.map((a) => num(fn, a))),
  ),
  keys: builtin(1, 1, "Keys of an object", (fn, [v]) => Object.keys(obj(fn, v))),
  values: builtin(1, 1, "Values of an object", (fn, [v]) => Object.values(obj(fn, v))),
  pick: builtin(2, Infinity, "Object with only the given keys", (fn, [v, ...ks]) => {
    const o = obj(fn, v);
    const keep = new Set(ks.map((k) => str(fn, k)));
    return Object.fromEntries(Object.entries(o).filter(([k]) => keep.has(k)));
  }),
  omit: builtin(2, Infinity, "Object without the given keys", (fn, [v, ...ks]) => {
    const drop = new Set(ks.map((k) => str(fn, k)));
    return Object.fromEntries(Object.entries(obj(fn, v)).filter(([k]) => !drop.has(k)));
  }),
  merge: builtin(1, Infinity, "Shallow-merge objects (later wins)", (fn, args) =>
    Object.fromEntries(
      args.flatMap((a) => (a === undefined || a === null ? [] : Object.entries(obj(fn, a)))),
    ),
  ),
  map: builtin(
    2,
    2,
    "Transform each element: map(xs, x => ...)",
    (fn, [v], lambda) => arr(fn, v).map((x) => toJson(lambda?.(x))),
    1,
  ),
  filter: builtin(
    2,
    2,
    "Keep elements matching: filter(xs, x => ...)",
    (fn, [v], lambda) => arr(fn, v).filter((x) => truthy(lambda?.(x))),
    1,
  ),
};

type Scope = { readonly doc: Value; readonly locals: ReadonlyMap<string, Value> };

const get = (target: Value, key: Value): Value => {
  if (target === undefined || target === null) {
    return undefined;
  }
  if (Array.isArray(target)) {
    if (typeof key !== "number" || !Number.isInteger(key)) {
      throw new ExprError(`Array index must be an integer, got ${typeOf(key)}`);
    }
    return target[key];
  }
  if (isObject(target)) {
    if (typeof key !== "string") {
      throw new ExprError(`Object key must be a string, got ${typeOf(key)}`);
    }
    return Object.hasOwn(target, key) ? target[key] : undefined;
  }
  if (typeof target === "string" && typeof key === "number") {
    return target.charAt(key) || undefined;
  }
  throw new ExprError(`Can't read '${String(key)}' of ${typeOf(target)}`);
};

const compare = (op: "<" | "<=" | ">" | ">=", a: Value, b: Value): boolean => {
  if (
    !(
      (typeof a === "number" && typeof b === "number") ||
      (typeof a === "string" && typeof b === "string")
    )
  ) {
    throw new ExprError(`Can't compare ${typeOf(a)} ${op} ${typeOf(b)}`);
  }
  switch (op) {
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
  }
};

const add = (a: Value, b: Value): Value => {
  if (typeof a === "number" && typeof b === "number") {
    return finite(a + b);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return [...a, ...b];
  }
  if (
    (typeof a === "string" &&
      (typeof b === "string" || typeof b === "number" || typeof b === "boolean")) ||
    (typeof b === "string" && (typeof a === "number" || typeof a === "boolean"))
  ) {
    return String(a) + String(b);
  }
  throw new ExprError(`Can't add ${typeOf(a)} and ${typeOf(b)} (use ?? to supply a default)`);
};

/**
 * Work budget for one `run`. Every node evaluated costs 1, and every string or
 * array produced costs its length, so nested `map`s or doubling concatenations
 * over a large document fail fast instead of burning the Worker's CPU limit.
 */
const STEP_BUDGET = 1_000_000;
let remaining = STEP_BUDGET;

const charge = (cost: number) => {
  remaining -= cost;
  if (remaining < 0) {
    throw new ExprError("Expression exceeded its work budget");
  }
};

const sized = (value: Value): Value => {
  if (typeof value === "string" || Array.isArray(value)) {
    charge(value.length);
  }
  return value;
};

const evaluate = (e: Expr, scope: Scope): Value => {
  charge(1);
  switch (e.k) {
    case "lit":
      return e.v;
    case "var": {
      if (scope.locals.has(e.name)) {
        return scope.locals.get(e.name);
      }
      if (e.name === "$") {
        return scope.doc;
      }
      return get(scope.doc, e.name);
    }
    case "get":
      return get(evaluate(e.obj, scope), evaluate(e.key, scope));
    case "arr":
      return e.items.map((item) => toJson(evaluate(item, scope)));
    case "obj":
      return Object.fromEntries(
        e.entries.flatMap(([k, v]) => {
          const value = evaluate(v, scope);
          return value === undefined ? [] : [[k, value]];
        }),
      );
    case "cond":
      return truthy(evaluate(e.c, scope)) ? evaluate(e.t, scope) : evaluate(e.f, scope);
    case "unary": {
      const v = evaluate(e.e, scope);
      return e.op === "!" ? !truthy(v) : -num("-", v);
    }
    case "bin": {
      const l = evaluate(e.l, scope);
      switch (e.op) {
        case "&&":
          return truthy(l) ? evaluate(e.r, scope) : l;
        case "||":
          return truthy(l) ? l : evaluate(e.r, scope);
        case "??":
          return l === undefined || l === null ? evaluate(e.r, scope) : l;
      }
      const r = evaluate(e.r, scope);
      switch (e.op) {
        case "+":
          return sized(add(l, r));
        case "-":
          return finite(num("-", l) - num("-", r));
        case "*":
          return finite(num("*", l) * num("*", r));
        case "/":
          return finite(num("/", l) / num("/", r));
        case "%":
          return finite(num("%", l) % num("%", r));
        case "==":
          return jsonEquals(l, r);
        case "!=":
          return !jsonEquals(l, r);
        case "<":
        case "<=":
        case ">":
        case ">=":
          return compare(e.op, l, r);
      }
    }
    // falls through: every binary operator returns above
    case "call": {
      const fn = BUILTINS[e.fn];
      if (fn === undefined) {
        throw new ExprError(`Unknown function '${e.fn}'`);
      }
      let lambda: ((v: Value) => Value) | undefined;
      const args: Array<Value> = [];
      for (const arg of e.args) {
        if (arg.k === "lambda") {
          lambda = (v) =>
            evaluate(arg.body, {
              doc: scope.doc,
              locals: new Map([...scope.locals, [arg.param, v]]),
            });
        } else {
          args.push(evaluate(arg, scope));
        }
      }
      return sized(fn.call(e.fn, args, lambda));
    }
  }
};

/** Evaluate a parsed expression against a document. Throws {@link ExprError}. */
export const run = (e: Expr, doc: Value): Value => {
  // NOTE: evaluation is synchronous, so a module-level budget can't be shared
  // between concurrent runs.
  remaining = STEP_BUDGET;
  return evaluate(e, { doc, locals: new Map() });
};

/** Field names referenced at the top level of the document (best effort, for docs/UI). */
export const freeVariables = (
  e: Expr | Lambda,
  bound: ReadonlySet<string> = new Set(),
): Set<string> => {
  const out = new Set<string>();
  const visit = (x: Expr | Lambda, b: ReadonlySet<string>) => {
    switch (x.k) {
      case "var":
        if (!b.has(x.name) && x.name !== "$") {
          out.add(x.name);
        }
        return;
      case "lambda":
        visit(x.body, new Set([...b, x.param]));
        return;
      case "get":
        visit(x.obj, b);
        visit(x.key, b);
        return;
      case "call":
        x.args.forEach((a) => visit(a, b));
        return;
      case "unary":
        visit(x.e, b);
        return;
      case "bin":
        visit(x.l, b);
        visit(x.r, b);
        return;
      case "cond":
        visit(x.c, b);
        visit(x.t, b);
        visit(x.f, b);
        return;
      case "arr":
        x.items.forEach((i) => visit(i, b));
        return;
      case "obj":
        x.entries.forEach(([, v]) => visit(v, b));
        return;
      case "lit":
        return;
    }
  };
  visit(e, bound);
  return out;
};
