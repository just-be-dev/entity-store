import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";
import { exampleDocument, parseJson, prettyJson } from "./json.ts";

describe("json helpers", () => {
  it("parses JSON and keeps the parser's message on failure", () => {
    expect(parseJson('{"a":[1,null]}')).toEqual(Result.succeed({ a: [1, null] }));
    const bad = parseJson("{ a: 1 }");
    expect(Result.isFailure(bad)).toBe(true);
    expect(Result.isFailure(bad) && bad.failure).not.toBe("");
    expect(Result.isFailure(parseJson(""))).toBe(true);
  });

  it("pretty-prints with two spaces", () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("builds a starting document with required fields only", () => {
    expect(
      exampleDocument({
        fields: {
          name: { type: "string" },
          age: { type: "number", optional: true },
          role: { type: "enum", values: ["admin", "member"] },
          active: { type: "boolean" },
          tags: { type: "array", items: { type: "string" } },
          address: {
            type: "object",
            fields: { city: { type: "string" }, zip: { type: "nullable", of: { type: "string" } } },
          },
          extra: { type: "json" },
        },
      }),
    ).toEqual({
      name: "",
      role: "admin",
      active: false,
      tags: [],
      address: { city: "", zip: null },
      extra: null,
    });
    expect(exampleDocument("not a schema")).toEqual({});
  });
});
