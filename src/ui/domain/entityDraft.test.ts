import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type { EntitySchema } from "../../schema/model.ts";
import { cellText, formFields, idProblem, patchOf, textsOf, valueOf } from "./entityDraft.ts";

const schema: EntitySchema = {
  fields: {
    name: { type: "string", minLength: 2 },
    email: { type: "string", format: "email", optional: true },
    age: { type: "number", integer: true, min: 0, optional: true },
    active: { type: "boolean", optional: true },
    born: { type: "string", format: "date", optional: true },
    seen: { type: "string", format: "datetime", optional: true },
    role: { type: "enum", values: ["admin", "member"], optional: true },
    manager: { type: "link", to: "person", optional: true },
    tags: { type: "array", items: { type: "string" }, optional: true },
  },
};
const fields = formFields(schema);
const fieldNamed = (name: string) => {
  const found = fields.find((field) => field.name === name);
  if (found === undefined) {
    throw new Error(name);
  }
  return found;
};

describe("entity drafts", () => {
  it("picks an input per field", () => {
    expect(fields.map((field) => field.input._tag)).toEqual([
      "Text",
      "Text",
      "Number",
      "Boolean",
      "Date",
      "DateTime",
      "Choice",
      "Link",
      "Json",
    ]);
  });

  it("checks each value against its field's definition", () => {
    expect(valueOf(fieldNamed("name"), "A")).toEqual(
      Result.fail(expect.stringContaining("length")),
    );
    expect(valueOf(fieldNamed("name"), "")).toEqual(Result.fail("Required"));
    expect(valueOf(fieldNamed("email"), "nope")).toEqual(
      Result.fail(expect.stringContaining("email")),
    );
    expect(valueOf(fieldNamed("age"), "1.5")).toEqual(Result.fail(expect.any(String)));
    expect(valueOf(fieldNamed("age"), "abc")).toEqual(Result.fail("Enter a whole number"));
    expect(valueOf(fieldNamed("age"), "42")).toEqual(Result.succeed(Option.some(42)));
    expect(valueOf(fieldNamed("active"), "false")).toEqual(Result.succeed(Option.some(false)));
    expect(valueOf(fieldNamed("seen"), "2026-10-24T09:30")).toEqual(
      Result.succeed(Option.some("2026-10-24T09:30:00Z")),
    );
    expect(valueOf(fieldNamed("manager"), " ada ")).toEqual(Result.succeed(Option.some("ada")));
    expect(valueOf(fieldNamed("manager"), "..")).toEqual(Result.fail(expect.any(String)));
    expect(valueOf(fieldNamed("tags"), '["a"]')).toEqual(Result.succeed(Option.some(["a"])));
    expect(valueOf(fieldNamed("tags"), "[1]")).toEqual(Result.fail(expect.any(String)));
  });

  it("shows stored values as input text, datetimes in UTC", () => {
    expect(
      textsOf(fields, {
        name: "Ada",
        age: 36,
        active: true,
        seen: "2026-10-24T11:30:00+02:00",
        tags: ["x"],
      }),
    ).toMatchObject({
      name: "Ada",
      email: "",
      age: "36",
      active: "true",
      seen: "2026-10-24T09:30:00",
      tags: '[\n  "x"\n]',
    });
  });

  it("creates from filled inputs only", () => {
    const values = { ...textsOf(fields, {}), name: "Ada", age: "36", active: "true" };
    expect(patchOf(fields, values, {}, "create")).toEqual(
      Result.succeed({ name: "Ada", age: 36, active: true }),
    );
  });

  it("edits send only changed inputs, with null for an emptied one", () => {
    const initial = textsOf(fields, { name: "Ada", email: "ada@example.com", age: 36 });
    const values = { ...initial, email: "", age: "37" };
    expect(patchOf(fields, values, initial, "edit")).toEqual(
      Result.succeed({ email: null, age: 37 }),
    );
  });

  it("reports every input that can't be saved", () => {
    const values = { ...textsOf(fields, {}), name: "", age: "x" };
    expect(patchOf(fields, values, {}, "create")).toEqual(
      Result.fail([
        { field: "name", message: "Required" },
        { field: "age", message: "Enter a whole number" },
      ]),
    );
  });

  it("checks ids", () => {
    expect(idProblem("ada@example.com")).toEqual(Option.none());
    expect(Option.isSome(idProblem(".."))).toBe(true);
    expect(Option.isSome(idProblem("a b"))).toBe(true);
  });

  it("shows cells compactly", () => {
    expect(cellText(fieldNamed("active"), false)).toBe("No");
    expect(cellText(fieldNamed("tags"), ["a", "b"])).toBe('["a","b"]');
    expect(cellText(fieldNamed("email"), undefined)).toBe("");
  });
});
