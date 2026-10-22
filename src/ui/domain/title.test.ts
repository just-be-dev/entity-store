import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { entityTitle } from "./title.ts";

const schema = { title: "name", fields: { name: { type: "nullable", of: { type: "string" } } } };

describe("entity titles", () => {
  it("reads the field the schema's title names", () => {
    expect(entityTitle(schema, { name: "Ada" })).toEqual(Option.some("Ada"));
  });

  it("has none without a title, or when the field is missing, blank, or not a string", () => {
    expect(entityTitle({ fields: {} }, { name: "Ada" })).toEqual(Option.none());
    for (const data of [{}, { name: null }, { name: "  " }, { name: 3 }, null, "Ada"]) {
      expect(entityTitle(schema, data)).toEqual(Option.none());
    }
  });
});
