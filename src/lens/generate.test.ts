import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { compiled } from "../schema/compile.ts";
import type { EntitySchema } from "../schema/model.ts";
import { compileLens } from "./apply.ts";
import { checkLens } from "./check.ts";
import { type GeneratedVersion, type SchemaEdit, generateVersion } from "./generate.ts";

const generated = (current: EntitySchema, edit: SchemaEdit): GeneratedVersion => {
  const result = generateVersion(current, edit);
  if (Result.isFailure(result)) {
    throw new Error(result.failure.join("; "));
  }
  return result.success;
};

const problems = (current: EntitySchema, edit: SchemaEdit): ReadonlyArray<string> => {
  const result = generateVersion(current, edit);
  return Result.isFailure(result) ? result.failure : [];
};

/** Runs the real lens check on a generated version, against `existing` stored documents. */
const check = (current: EntitySchema, next: GeneratedVersion, existing: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const lens = compileLens(next.lens);
    if (Result.isFailure(lens)) {
      throw new Error(JSON.stringify(lens.failure));
    }
    return yield* checkLens({
      from: compiled(current),
      to: compiled(next.schema),
      lens: lens.success,
      existing,
      samples: 50,
    });
  });

const personFields = {
  name: { type: "string", minLength: 1, description: "Name" },
  email: { type: "string", format: "email", optional: true },
  nickname: { type: "nullable", of: { type: "string" }, optional: true },
  age: { type: "number", integer: true, optional: true },
  team: { type: "nullable", of: { type: "string" } },
} satisfies EntitySchema["fields"];

const person: EntitySchema = { title: "name", fields: personFields };

const keep = (name: keyof typeof personFields, rename?: string) => ({
  name: rename ?? name,
  from: name,
  type: personFields[name],
});

describe("generateVersion", () => {
  it.effect("renames a field, keeping its values and the title on it", () =>
    Effect.gen(function* () {
      const next = generated(person, {
        title: "fullName",
        fields: [
          keep("name", "fullName"),
          keep("email"),
          keep("nickname"),
          keep("age"),
          keep("team"),
        ],
      });
      expect(next.lens.ops).toEqual([{ op: "rename", from: "name", to: "fullName" }]);
      expect(next.schema.title).toBe("fullName");
      expect(next.changes).toEqual([
        {
          kind: "renamed",
          from: "name",
          to: "fullName",
          before: person.fields["name"],
          after: person.fields["name"],
        },
      ]);
      const report = yield* check(person, next, [{ name: "Ada", team: null }]);
      expect(report.ok).toBe(true);
      expect(report.examples[0]).toEqual({
        input: { name: "Ada", team: null },
        output: { fullName: "Ada", team: null },
      });
    }),
  );

  it.effect("adds optional fields and removes optional and nullable ones", () =>
    Effect.gen(function* () {
      const next = generated(person, {
        title: "name",
        fields: [
          keep("name"),
          keep("email"),
          keep("age"),
          { name: "joined", type: { type: "string", format: "date", optional: true } },
        ],
      });
      expect(next.lens.ops).toEqual([
        { op: "remove", field: "nickname" },
        { op: "remove", field: "team", default: null },
        { op: "add", field: "joined" },
      ]);
      const report = yield* check(person, next, [
        { name: "Ada", nickname: "ada", team: "core", age: 36 },
      ]);
      expect(report.ok).toBe(true);
      expect(report.existing.failures).toEqual([]);
    }),
  );

  it("orders a chain of renames so none overwrites another", () => {
    const schema: EntitySchema = {
      fields: { a: { type: "string" }, b: { type: "string" } },
    };
    const next = generated(schema, {
      fields: [
        { name: "b", from: "a", type: { type: "string" } },
        { name: "c", from: "b", type: { type: "string" } },
      ],
    });
    expect(next.lens.ops).toEqual([
      { op: "rename", from: "b", to: "c" },
      { op: "rename", from: "a", to: "b" },
    ]);
    const lens = compileLens(next.lens);
    if (Result.isFailure(lens)) {
      throw new Error("lens");
    }
    expect(lens.success.forward({ a: "1", b: "2" })).toEqual(Result.succeed({ b: "1", c: "2" }));
    expect(lens.success.backward({ b: "1", c: "2" })).toEqual(Result.succeed({ a: "1", b: "2" }));
  });

  it("removes a field and adds a new one under the freed name", () => {
    const schema: EntitySchema = {
      fields: { a: { type: "string", optional: true }, b: { type: "number" } },
    };
    const next = generated(schema, {
      fields: [
        { name: "a", from: "b", type: { type: "number" } },
        { name: "b", type: { type: "boolean", optional: true } },
      ],
    });
    expect(next.lens.ops).toEqual([
      { op: "remove", field: "a" },
      { op: "rename", from: "b", to: "a" },
      { op: "add", field: "b" },
    ]);
  });

  it("refuses a swap, kind changes, and changes old readers can't follow", () => {
    expect(
      problems(person, {
        fields: [keep("name", "email"), { name: "name", from: "email", type: personFields.email }],
      }),
    ).toContain("Fields can't swap names in one save: rename one of them first");
    expect(
      problems(person, {
        fields: [
          { name: "name", from: "name", type: { type: "number" } },
          keep("email"),
          keep("nickname"),
          keep("age"),
          keep("team"),
        ],
      }),
    ).toEqual(["name holds string; changing it to number needs a hand-written lens"]);
    expect(
      problems(person, {
        fields: [
          keep("name"),
          { name: "email", from: "email", type: { type: "string", format: "email" } },
          { name: "nickname", from: "nickname", type: { type: "string", optional: true } },
          keep("age"),
          keep("team"),
        ],
      }),
    ).toEqual([
      "email is optional now; making it required needs a value for entities without it, in a hand-written lens",
      "nickname can be null now, so it can't stop allowing null without a hand-written lens",
    ]);
  });

  it("refuses removing a required field and adding a required one", () => {
    expect(
      problems(person, {
        title: "nickname",
        fields: [
          keep("email"),
          keep("nickname"),
          keep("age"),
          keep("team"),
          { name: "role", type: { type: "string" } },
        ],
      }),
    ).toEqual([
      "name is required, so removing it needs a value for readers of the current version: write that lens by hand",
      "role is new, so existing entities don't have it: make it optional",
    ]);
  });

  it("reports schema definition problems and a title that isn't a field", () => {
    expect(
      problems(person, {
        title: "missing",
        fields: [
          keep("name"),
          keep("email"),
          keep("nickname"),
          keep("age"),
          keep("team"),
          { name: "bad name", type: { type: "string", optional: true } },
        ],
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("bad name: Field names must be identifiers"),
        expect.stringContaining("missing"),
      ]),
    );
  });

  it("treats descriptions and constraints as changes that need no ops, and says when nothing changed", () => {
    const same = generated(person, {
      title: "name",
      fields: [keep("name"), keep("email"), keep("nickname"), keep("age"), keep("team")],
    });
    expect(same.changed).toBe(false);
    expect(same.lens.ops).toEqual([]);
    const described = generated(person, {
      title: "name",
      fields: [
        { name: "name", from: "name", type: { type: "string", minLength: 1, description: "Full" } },
        keep("email"),
        keep("nickname"),
        keep("age"),
        keep("team"),
      ],
    });
    expect(described.changed).toBe(true);
    expect(described.lens.ops).toEqual([]);
    expect(described.changes).toEqual([
      {
        kind: "changed",
        name: "name",
        before: person.fields["name"],
        after: { type: "string", minLength: 1, description: "Full" },
      },
    ]);
  });

  it.effect("leaves a constraint the data can't meet to the lens check", () =>
    Effect.gen(function* () {
      const schema: EntitySchema = { fields: { born: { type: "string" } } };
      const next = generated(schema, {
        fields: [{ name: "born", from: "born", type: { type: "string", format: "date" } }],
      });
      const report = yield* check(schema, next, [{ born: "last spring" }]);
      expect(report.ok).toBe(false);
      expect(report.existing.failures[0]?.input).toEqual({ born: "last spring" });
    }),
  );
});
