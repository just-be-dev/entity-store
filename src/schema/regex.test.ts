import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";
import { compileRegex } from "./regex.ts";

const regex = (source: string) => {
  const compiled = compileRegex(source);
  if (Result.isFailure(compiled)) {
    throw new Error(compiled.failure);
  }
  return compiled.success;
};
const error = (source: string) => {
  const compiled = compileRegex(source);
  return Result.isFailure(compiled) ? compiled.failure : undefined;
};

describe("linear-time regex", () => {
  it("agrees with RegExp on the supported subset", () => {
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
      ["^[a-z]+(-[a-z]+)*$", ["abc", "a-b-c", "a--b", "-a", "", "ab-"]],
      ["^\\S+ \\S+$", ["Ada Lovelace", "Ada", "A B C", " x y"]],
      ["colou?r", ["color", "colour", "my colour!", "colr"]],
      ["^(ab|cd){2,3}$", ["abcd", "ab", "abcdab", "abcdabcd", "cdcdcd"]],
      ["^\\d{4}-\\d{2}-\\d{2}$", ["2026-10-19", "2026-1-19", "x2026-10-19"]],
      ["^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$", ["a@b.co", "a@b", "a b@c.d", "@b.co"]],
      ["^[\\w.+-]+$", ["a.b+c-d", "a b", "ü"]],
      ["^.$", ["😀", "ab", "\n"]],
      ["^[^a-c]*$", ["xyz", "xaz", ""]],
      ["^(?:x|y)*?z$", ["xyz", "z", "xyzz"]],
      ["\\$\\d+\\.\\d{2}", ["costs $12.50", "$1.5"]],
      ["^\\u0041\\u{1F600}$", ["A😀", "A"]],
      ["^[\\]\\-]+$", ["]-]", "a"]],
      ["^$", ["", "a"]],
      ["a|", ["", "b"]],
    ];
    for (const [source, inputs] of cases) {
      const ours = regex(source);
      const native = new RegExp(source, "u");
      for (const input of inputs) {
        expect([source, input, ours.test(input)]).toEqual([source, input, native.test(input)]);
      }
    }
  });

  it("stays linear on patterns that make backtracking engines explode", () => {
    const evil: ReadonlyArray<readonly [string, string]> = [
      ["^(a+)+$", `${"a".repeat(5000)}!`],
      ["^(a|a)+$", `${"a".repeat(5000)}!`],
      ["^(.*a){12}$", `${"a".repeat(2000)}!`],
      ["^(x\\w*)+$", `${"x".repeat(5000)}!`],
      ["^\\d*\\d*\\d*\\d*\\d*\\d*x$", "1".repeat(5000)],
      ["^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$", `a@${"a.".repeat(20000)} `],
    ];
    for (const [source, input] of evil) {
      const started = performance.now();
      expect(regex(source).test(input)).toBe(false);
      expect(performance.now() - started).toBeLessThan(1000);
    }
  });

  it("rejects syntax it can't match in linear time", () => {
    expect(error("(a)\\1")).toMatch(/Unsupported escape/);
    expect(error("a(?=b)")).toMatch(/Lookaround/);
    expect(error("\\bword")).toMatch(/\\b/);
    expect(error("a{1001}")).toMatch(/limited/);
    expect(error("(ab|cd|ef){900}")).toMatch(/too large/);
    expect(error("(ab")).toMatch(/Unterminated group/);
    expect(error("[a-")).toMatch(/Unterminated/);
    expect(error("*a")).toMatch(/Nothing to repeat/);
    expect(error("[z-a]")).toMatch(/out of order/);
  });
});
