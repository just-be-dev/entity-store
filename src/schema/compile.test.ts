import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";
import { checkDefinition, compiled } from "./compile.ts";
import type { EntitySchema, FieldType } from "./model.ts";

describe("schema definitions", () => {
  it("compiles every type into a strict validator", () => {
    const schema: EntitySchema = {
      fields: {
        name: { type: "string", minLength: 1, maxLength: 5 },
        age: { type: "number", integer: true, min: 0, optional: true },
        role: { type: "enum", values: ["admin", "member"] },
        tags: { type: "array", items: { type: "string" }, maxItems: 2 },
        address: { type: "object", fields: { zip: { type: "nullable", of: { type: "string" } } } },
        email: { type: "string", format: "email" },
        extra: { type: "json" },
      },
    };
    const { validate } = compiled(schema);
    const good = {
      name: "Ada",
      role: "admin",
      tags: ["a"],
      address: { zip: null },
      email: "a@b.co",
      extra: { anything: [1, "x"] },
    };
    expect(Result.isSuccess(validate(good))).toBe(true);
    expect(Result.isSuccess(validate({ ...good, age: 3 }))).toBe(true);
    for (const bad of [
      { ...good, name: "" },
      { ...good, name: "toolong" },
      { ...good, age: 1.5 },
      { ...good, age: -1 },
      { ...good, role: "owner" },
      { ...good, tags: ["a", "b", "c"] },
      { ...good, address: {} },
      { ...good, email: "nope" },
      { ...good, unknown: 1 },
      { ...good, age: Number.NaN },
    ]) {
      expect(Result.isFailure(validate(bad))).toBe(true);
    }
  });

  it("reports definition problems with paths", () => {
    const fields: EntitySchema["fields"] = Object.fromEntries<FieldType>([
      ["bad name", { type: "string" }],
      ["constructor", { type: "boolean" }],
      ["n", { type: "number", min: 3, max: 1 }],
      ["e", { type: "enum", values: [] }],
      ["nested", { type: "object", fields: { p: { type: "string", pattern: "(" } } }],
      ["list", { type: "array", items: { type: "string", optional: true } }],
    ]);
    const issues = checkDefinition({ fields });
    expect(issues.map((i) => i.path)).toEqual([
      "bad name",
      "constructor",
      "n",
      "e",
      "nested.p",
      "list[]",
    ]);
  });

  it("rejects patterns prone to catastrophic backtracking", () => {
    const check = (pattern: string) =>
      checkDefinition({ fields: { s: { type: "string", pattern } } }).map((i) => i.message);
    expect(check("^(a+)+$")[0]).toMatch(/nests quantifiers/);
    expect(check("^(\\w*x)*$")[0]).toMatch(/nests quantifiers/);
    expect(check("^(ab|cd){2,}$")).toEqual([]);
    expect(check("^[a-z]+(-[a-z]+)*$")).toEqual([]);
    expect(check("x".repeat(201))[0]).toMatch(/limited/);
  });
});
