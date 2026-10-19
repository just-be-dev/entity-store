import * as Result from "effect/Result";

/**
 * A linear-time regular expression matcher for schema `pattern`s.
 *
 * Patterns are user data that run on every write and read, so JavaScript's
 * backtracking RegExp is a denial-of-service risk (`(a|a)+`, `(.*a){12}`).
 * This is a Thompson NFA simulation: time is O(input × pattern) whatever the
 * pattern. It supports the regular subset of JS syntax with `u`-flag code
 * point semantics: literals, `.`, classes (`[a-z]`, `[^…]`), `\d \w \s` and
 * their negations, escapes, `^`, `$`, groups (`(…)`, `(?:…)`), `|`, and the
 * quantifiers `* + ? {n} {n,} {n,m}` (lazy forms are accepted and match the
 * same strings). Backreferences, lookaround, and `\b` are rejected.
 */

type Pred = (cp: number) => boolean;

type Node =
  | { readonly k: "char"; readonly test: Pred }
  | { readonly k: "start" }
  | { readonly k: "end" }
  | { readonly k: "seq"; readonly items: ReadonlyArray<Node> }
  | { readonly k: "alt"; readonly branches: ReadonlyArray<Node> }
  | { readonly k: "repeat"; readonly node: Node; readonly min: number; readonly max: number };

class RegexError extends Error {
  override readonly name = "RegexError";
}

const MAX_REPEAT = 1000;
const MAX_STATES = 2000;

const isDigit: Pred = (c) => c >= 48 && c <= 57;
const isWord: Pred = (c) => isDigit(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const SPACE = new Set([
  9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201,
  8202, 8232, 8233, 8239, 8287, 12288, 65279,
]);
const isSpace: Pred = (c) => SPACE.has(c);
const isLineTerminator = (c: number) => c === 10 || c === 13 || c === 8232 || c === 8233;
const not =
  (p: Pred): Pred =>
  (c) =>
    !p(c);

class Parser {
  private i = 0;
  private readonly cps: ReadonlyArray<number>;
  constructor(source: string) {
    this.cps = Array.from(source, (ch) => ch.codePointAt(0) ?? 0);
  }

  private peek() {
    return this.cps[this.i];
  }
  private eat(c: string) {
    if (this.peek() === c.codePointAt(0)) {
      this.i++;
      return true;
    }
    return false;
  }
  private fail(message: string): never {
    throw new RegexError(`${message} at position ${this.i}`);
  }

  parse(): Node {
    const node = this.alternation();
    if (this.i < this.cps.length) {
      this.fail("Unexpected ')'");
    }
    return node;
  }

  private alternation(): Node {
    const branches = [this.sequence()];
    while (this.eat("|")) {
      branches.push(this.sequence());
    }
    return branches.length === 1 && branches[0] !== undefined
      ? branches[0]
      : { k: "alt", branches };
  }

  private sequence(): Node {
    const items: Array<Node> = [];
    for (;;) {
      const c = this.peek();
      if (c === undefined || c === 0x7c /* | */ || c === 0x29 /* ) */) {
        return { k: "seq", items };
      }
      items.push(this.quantified(this.atom()));
    }
  }

  private number(): number | undefined {
    let digits = "";
    for (let c = this.peek(); c !== undefined && isDigit(c); c = this.peek()) {
      digits += String.fromCodePoint(c);
      this.i++;
    }
    return digits === "" ? undefined : Number(digits);
  }

  private quantified(node: Node): Node {
    let min: number;
    let max: number;
    if (this.eat("*")) {
      [min, max] = [0, Infinity];
    } else if (this.eat("+")) {
      [min, max] = [1, Infinity];
    } else if (this.eat("?")) {
      [min, max] = [0, 1];
    } else if (this.peek() === 0x7b /* { */) {
      const save = this.i;
      this.i++;
      const lo = this.number();
      if (lo === undefined) {
        this.i = save;
        return node;
      }
      let hi: number = lo;
      if (this.eat(",")) {
        hi = this.number() ?? Infinity;
      }
      if (!this.eat("}")) {
        this.fail("Unterminated {n,m} quantifier");
      }
      if (hi < lo) {
        this.fail("Quantifier range is out of order");
      }
      if (lo > MAX_REPEAT || (hi !== Infinity && hi > MAX_REPEAT)) {
        this.fail(`Repeat counts are limited to ${MAX_REPEAT}`);
      }
      [min, max] = [lo, hi];
    } else {
      return node;
    }
    this.eat("?");
    if (node.k === "start" || node.k === "end") {
      this.fail("Nothing to repeat");
    }
    const c = this.peek();
    if (c === 0x2a || c === 0x2b) {
      this.fail("Nothing to repeat");
    }
    return { k: "repeat", node, min, max };
  }

  private atom(): Node {
    const c = this.peek();
    if (c === undefined) {
      this.fail("Unexpected end of pattern");
    }
    this.i++;
    switch (c) {
      case 0x5e /* ^ */:
        return { k: "start" };
      case 0x24 /* $ */:
        return { k: "end" };
      case 0x2e /* . */:
        return { k: "char", test: not(isLineTerminator) };
      case 0x28 /* ( */: {
        if (this.eat("?")) {
          if (!this.eat(":")) {
            this.fail("Lookaround and named groups aren't supported; use (…) or (?:…)");
          }
        }
        const inner = this.alternation();
        if (!this.eat(")")) {
          this.fail("Unterminated group");
        }
        return inner;
      }
      case 0x5b /* [ */:
        return { k: "char", test: this.classBody() };
      case 0x5c /* \ */:
        return { k: "char", test: this.escape(false) };
      case 0x2a:
      case 0x2b:
      case 0x3f:
        return this.fail("Nothing to repeat");
      case 0x29:
        return this.fail("Unexpected ')'");
      default:
        return { k: "char", test: (x) => x === c };
    }
  }

  private escape(inClass: boolean): Pred {
    const c = this.peek();
    if (c === undefined) {
      this.fail("Pattern ends with \\");
    }
    this.i++;
    const ch = String.fromCodePoint(c);
    switch (ch) {
      case "d":
        return isDigit;
      case "D":
        return not(isDigit);
      case "w":
        return isWord;
      case "W":
        return not(isWord);
      case "s":
        return isSpace;
      case "S":
        return not(isSpace);
      case "n":
        return (x) => x === 10;
      case "t":
        return (x) => x === 9;
      case "r":
        return (x) => x === 13;
      case "f":
        return (x) => x === 12;
      case "v":
        return (x) => x === 11;
      case "0":
        return (x) => x === 0;
      case "u": {
        const cp = this.unicodeEscape();
        return (x) => x === cp;
      }
      case "b":
        if (inClass) {
          return (x) => x === 8;
        }
        return this.fail("\\b isn't supported");
      default:
        if (/[A-Za-z0-9]/.test(ch)) {
          return this.fail(`Unsupported escape \\${ch}`);
        }
        return (x) => x === c;
    }
  }

  private unicodeEscape(): number {
    let hex = "";
    if (this.eat("{")) {
      for (let c = this.peek(); c !== undefined && c !== 0x7d; c = this.peek()) {
        hex += String.fromCodePoint(c);
        this.i++;
      }
      if (!this.eat("}")) {
        this.fail("Unterminated \\u{…}");
      }
    } else {
      for (let n = 0; n < 4; n++) {
        const c = this.peek();
        hex += c === undefined ? "" : String.fromCodePoint(c);
        this.i++;
      }
    }
    if (!/^[0-9a-fA-F]{1,6}$/.test(hex) || parseInt(hex, 16) > 0x10ffff) {
      this.fail("Invalid \\u escape");
    }
    return parseInt(hex, 16);
  }

  private classBody(): Pred {
    const negated = this.eat("^");
    const parts: Array<Pred> = [];
    let first = true;
    for (;;) {
      const c = this.peek();
      if (c === undefined) {
        this.fail("Unterminated character class");
      }
      if (c === 0x5d /* ] */ && !first) {
        this.i++;
        break;
      }
      if (c === 0x5d && first) {
        this.i++;
        break;
      }
      first = false;
      const lo = this.classAtom();
      if (this.peek() === 0x2d /* - */ && this.cps[this.i + 1] !== 0x5d && typeof lo === "number") {
        this.i++;
        const hi = this.classAtom();
        if (typeof hi !== "number") {
          this.fail("Invalid class range");
        }
        if (hi < lo) {
          this.fail("Class range is out of order");
        }
        parts.push((x) => x >= lo && x <= hi);
      } else {
        parts.push(typeof lo === "number" ? (x) => x === lo : lo);
      }
    }
    const any: Pred = (x) => parts.some((p) => p(x));
    return negated ? not(any) : any;
  }

  /** A single code point (usable in a range) or a class escape like \d. */
  private classAtom(): number | Pred {
    const c = this.peek();
    if (c === undefined) {
      this.fail("Unterminated character class");
    }
    this.i++;
    if (c !== 0x5c) {
      return c;
    }
    const next = this.peek();
    const simple: Record<string, number> = { n: 10, t: 9, r: 13, f: 12, v: 11, "0": 0, b: 8 };
    const key = next === undefined ? "" : String.fromCodePoint(next);
    if (Object.hasOwn(simple, key)) {
      this.i++;
      return simple[key] ?? 0;
    }
    if (key === "u") {
      this.i++;
      return this.unicodeEscape();
    }
    if (key !== "" && !/[A-Za-z0-9]/.test(key)) {
      this.i++;
      return next ?? 0;
    }
    return this.escape(true);
  }
}

// ─── Thompson NFA ───────────────────────────────────────────────────────────

type State =
  | { k: "char"; test: Pred; out: number }
  | { k: "split"; a: number; b: number }
  | { k: "start"; out: number }
  | { k: "end"; out: number }
  | { k: "match" };

class Builder {
  readonly states: Array<State> = [];

  private add(state: State): number {
    if (this.states.length >= MAX_STATES) {
      throw new RegexError("Pattern is too large");
    }
    this.states.push(state);
    return this.states.length - 1;
  }

  /** Compile `node` so that it continues to state `next`; returns its entry state. */
  build(node: Node, next: number): number {
    switch (node.k) {
      case "char":
        return this.add({ k: "char", test: node.test, out: next });
      case "start":
        return this.add({ k: "start", out: next });
      case "end":
        return this.add({ k: "end", out: next });
      case "seq":
        return node.items.reduceRight((acc, item) => this.build(item, acc), next);
      case "alt": {
        const entries = node.branches.map((branch) => this.build(branch, next));
        return entries.reduceRight((acc, entry) => this.add({ k: "split", a: entry, b: acc }));
      }
      case "repeat": {
        let tail: number;
        if (node.max === Infinity) {
          const loop = this.add({ k: "split", a: -1, b: next });
          const body = this.build(node.node, loop);
          const state = this.states[loop];
          if (state?.k === "split") {
            state.a = body;
          }
          tail = loop;
        } else {
          tail = next;
          for (let n = node.min; n < node.max; n++) {
            tail = this.add({ k: "split", a: this.build(node.node, tail), b: next });
          }
        }
        for (let n = 0; n < node.min; n++) {
          tail = this.build(node.node, tail);
        }
        return tail;
      }
    }
  }
}

export interface SafeRegex {
  readonly test: (input: string) => boolean;
}

export const compileRegex = (source: string): Result.Result<SafeRegex, string> => {
  try {
    const ast = new Parser(source).parse();
    const builder = new Builder();
    const match = builder.states.length;
    builder.states.push({ k: "match" });
    const start = builder.build(ast, match);
    const states = builder.states;

    const test = (input: string): boolean => {
      const cps = Array.from(input, (ch) => ch.codePointAt(0) ?? 0);
      let current = new Set<number>();
      const addState = (set: Set<number>, s: number, pos: number) => {
        const stack = [s];
        while (stack.length > 0) {
          const id = stack.pop() ?? match;
          if (set.has(id)) {
            continue;
          }
          set.add(id);
          const state = states[id];
          if (state === undefined) {
            continue;
          }
          if (state.k === "split") {
            stack.push(state.b, state.a);
          } else if (state.k === "start" && pos === 0) {
            stack.push(state.out);
          } else if (state.k === "end" && pos === cps.length) {
            stack.push(state.out);
          }
        }
      };
      for (let pos = 0; pos <= cps.length; pos++) {
        // Unanchored search, like RegExp.prototype.test: a match may start anywhere.
        addState(current, start, pos);
        if (current.has(match)) {
          return true;
        }
        const cp = cps[pos];
        if (cp === undefined) {
          break;
        }
        const next = new Set<number>();
        for (const id of current) {
          const state = states[id];
          if (state?.k === "char" && state.test(cp)) {
            addState(next, state.out, pos + 1);
          }
        }
        current = next;
      }
      return current.has(match);
    };
    return Result.succeed({ test });
  } catch (error) {
    return Result.fail(error instanceof Error ? error.message : String(error));
  }
};
