import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";
import type { Value } from "./expr.ts";
import { parse, run } from "./expr.ts";

const evaluate = (source: string, doc: Value = {}) => {
  const parsed = parse(source);
  if (Result.isFailure(parsed)) {
    throw new Error(parsed.failure);
  }
  return run(parsed.success, doc);
};

const parseError = (source: string) => {
  const parsed = parse(source);
  return Result.isFailure(parsed) ? parsed.failure : undefined;
};

describe("lens expressions", () => {
  it("reads fields, nested paths, and indexes", () => {
    const doc = { name: { first: "Ada", last: "Lovelace" }, tags: ["a", "b"] };
    expect(evaluate("name.first + ' ' + name.last", doc)).toBe("Ada Lovelace");
    expect(evaluate("tags[1]", doc)).toBe("b");
    expect(evaluate("$.tags", doc)).toEqual(["a", "b"]);
    expect(evaluate("missing.deep.path", doc)).toBeUndefined();
  });

  it("splits a full name back into parts", () => {
    const doc = { fullName: "Grace Brewster Hopper" };
    expect(evaluate("split(fullName, ' ')[0]", doc)).toBe("Grace");
    expect(evaluate("join(slice(split(fullName, ' '), 1), ' ')", doc)).toBe("Brewster Hopper");
  });

  it("follows precedence and short-circuits", () => {
    expect(evaluate("1 + 2 * 3")).toBe(7);
    expect(evaluate("(1 + 2) * 3")).toBe(9);
    expect(evaluate("-2 * 3 + 10 % 4")).toBe(-4);
    expect(evaluate("1 < 2 && 'x' || 'y'")).toBe("x");
    expect(evaluate("missing ?? 'fallback'")).toBe("fallback");
    expect(evaluate("0 ?? 5")).toBe(0);
    expect(evaluate("status == 'done' ? 'closed' : 'open'", { status: "done" })).toBe("closed");
    expect(evaluate("a == b", { a: [1, { x: 2 }], b: [1, { x: 2 }] })).toBe(true);
  });

  it("supports lambdas, literals, and object construction", () => {
    expect(evaluate("map(tags, t => upper(t))", { tags: ["a", "b"] })).toEqual(["A", "B"]);
    expect(evaluate("filter(xs, x => x > 1)", { xs: [1, 2, 3] })).toEqual([2, 3]);
    expect(evaluate("{ city, zip: string(zip) }", { city: "Oslo", zip: 150 })).toEqual({
      city: "Oslo",
      zip: "150",
    });
    expect(evaluate("[1, 'two', null]")).toEqual([1, "two", null]);
    expect(evaluate("merge(a, { y: 2 })", { a: { x: 1, y: 1 } })).toEqual({ x: 1, y: 2 });
    expect(evaluate("round(price / 100, 2)", { price: 1999 })).toBe(19.99);
  });

  it("fails loudly on type errors instead of producing junk", () => {
    expect(() => evaluate("a + b", { a: "x" })).toThrow(/Can't add string and undefined/);
    expect(() => evaluate("1 / 0")).toThrow(/non-finite/);
    expect(() => evaluate("number('abc')")).toThrow(/can't convert/);
    expect(() => evaluate("1 < 'a'")).toThrow(/Can't compare/);
  });

  it("can't reach prototypes or globals", () => {
    expect(evaluate("constructor", {})).toBeUndefined();
    expect(evaluate("x.__proto__", { x: {} })).toBeUndefined();
    expect(evaluate("$['constructor']", {})).toBeUndefined();
    expect(parseError("globalThis()")).toMatch(/Unknown function/);
    expect(parseError("eval('1')")).toMatch(/Unknown function/);
    expect(parseError("toString()")).toMatch(/Unknown function/);
  });

  it("reports syntax errors with positions", () => {
    expect(parseError("a +")).toMatch(/Unexpected end/);
    expect(parseError("'open")).toMatch(/Unterminated string/);
    expect(parseError("a b")).toMatch(/Unexpected input at 2/);
    expect(parseError("split(a)")).toMatch(/takes 2 argument/);
    expect(parseError("map(xs, upper(x))")).toMatch(/expects a function/);
    expect(parseError("x".repeat(5000))).toMatch(/limited/);
  });
});
