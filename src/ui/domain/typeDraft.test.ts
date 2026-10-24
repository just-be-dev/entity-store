import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { modifyFields } from "foldkit/struct";
import type { EntitySchema } from "../../schema/model.ts";
import {
  blankField,
  describeField,
  draftOf,
  newTypeDraft,
  nextVersionOf,
  schemaOf,
  type TypeDraft,
} from "./typeDraft.ts";

const person: EntitySchema = {
  title: "name",
  fields: {
    name: { type: "string", minLength: 1, description: "Full name" },
    email: { type: "string", format: "email", optional: true },
    manager: { type: "nullable", of: { type: "link", to: "person" }, optional: true },
    role: { type: "enum", values: ["admin", "member"], optional: true },
    tags: { type: "array", items: { type: "string" }, optional: true },
  },
};

const withField = (draft: TypeDraft, key: number, change: Parameters<typeof modifyFields>[1]) =>
  modifyFields(draft, {
    fields: (fields) =>
      fields.map((field) =>
        field.key === key ? (modifyFields(field, change as never) as typeof field) : field,
      ),
  });

describe("type drafts", () => {
  it("reads a schema into rows and back without losing constraints", () => {
    const draft = draftOf("person", person);
    expect(draft.fields.map((field) => [field.name, field.kind, field.isRequired])).toEqual([
      ["name", "text", true],
      ["email", "email", false],
      ["manager", "link", false],
      ["role", "choice", false],
      ["tags", "other", false],
    ]);
    expect(draft.maybeTitleKey).toEqual(Option.some(0));
    expect(schemaOf(draft)).toEqual(Result.succeed(person));
  });

  it("builds a new type's schema from rows, with the title on the chosen row", () => {
    const draft = modifyFields(newTypeDraft, {
      fields: (fields) => [
        ...fields,
        modifyFields(blankField(1), {
          name: () => "boss",
          kind: () => "link",
          to: () => "person",
        }),
        modifyFields(blankField(2), {
          name: () => "level",
          kind: () => "choice",
          values: () => "junior, senior, junior",
        }),
      ],
    });
    expect(schemaOf(draft)).toEqual(
      Result.succeed({
        title: "name",
        fields: {
          name: { type: "string" },
          boss: { type: "link", to: "person", optional: true },
          level: { type: "enum", values: ["junior", "senior"], optional: true },
        },
      }),
    );
  });

  it("names what to fix before anything is sent", () => {
    const draft = modifyFields(newTypeDraft, {
      maybeTitleKey: () => Option.some(1),
      fields: (fields) => [
        ...fields,
        modifyFields(blankField(1), { name: () => "boss", kind: () => "link" }),
        modifyFields(blankField(2), { name: () => "name" }),
        modifyFields(blankField(3), { name: () => "bad name", kind: () => "choice" }),
      ],
    });
    expect(schemaOf(draft)).toEqual(
      Result.fail([
        "More than one field is named name",
        "Choose the type boss points to",
        "bad name: field names use letters, digits and '_', and start with a letter or '_'",
        "Give bad name at least one choice",
        "boss can't be the title: a title is a text field",
      ]),
    );
  });

  it("keeps the title on a renamed row and generates a rename", () => {
    const draft = withField(draftOf("person", person), 0, { name: () => "fullName" });
    const next = nextVersionOf(person, draft);
    expect(Result.map(next, (version) => [version.schema.title, version.lens.ops])).toEqual(
      Result.succeed(["fullName", [{ op: "rename", from: "name", to: "fullName" }]]),
    );
  });

  it("refuses changing a row's kind", () => {
    const draft = withField(draftOf("person", person), 1, { kind: () => "number" });
    expect(nextVersionOf(person, draft)).toEqual(
      Result.fail(["email holds string; changing it to number needs a hand-written lens"]),
    );
  });

  it("describes a definition in words", () => {
    expect(describeField({ type: "nullable", of: { type: "link", to: "team" } })).toBe(
      "Link to team, required, can be null",
    );
    expect(describeField({ type: "string", format: "date", optional: true })).toBe(
      "Date, optional",
    );
  });
});
