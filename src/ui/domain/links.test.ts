import { describe, expect, it } from "@effect/vitest";
import { exampleDocument } from "./json.ts";
import { linkedTypes, outgoingLinks } from "./links.ts";

const postSchema = {
  fields: {
    title: { type: "string" },
    author: { type: "link", to: "person" },
    reviewers: { type: "array", items: { type: "link", to: "person" } },
    meta: {
      type: "object",
      fields: { editor: { type: "nullable", of: { type: "link", to: "person" } } },
    },
    topic: { type: "link", to: "topic", optional: true },
  },
};

describe("links", () => {
  it("finds links at nested paths, sharing `[]` for array elements", () => {
    expect(
      outgoingLinks(postSchema, {
        title: "Hi",
        author: "ada",
        reviewers: ["alan", "grace", "alan"],
        meta: { editor: null },
      }),
    ).toEqual([
      { path: "author", target: "ada", targetType: "person" },
      { path: "reviewers[]", target: "alan", targetType: "person" },
      { path: "reviewers[]", target: "grace", targetType: "person" },
    ]);
    expect(outgoingLinks(postSchema, { meta: { editor: "ada" } })).toEqual([
      { path: "meta.editor", target: "ada", targetType: "person" },
    ]);
  });

  it("ignores values that don't fit the schema", () => {
    expect(outgoingLinks(postSchema, { author: 3, reviewers: "ada", meta: [] })).toEqual([]);
    expect(outgoingLinks("not a schema", { author: "ada" })).toEqual([]);
  });

  it("lists the types a schema links to", () => {
    expect(linkedTypes(postSchema)).toEqual(["person", "topic"]);
  });

  it("starts links blank in new documents", () => {
    expect(exampleDocument(postSchema)).toEqual({
      title: "",
      author: "",
      reviewers: [],
      meta: { editor: null },
    });
  });
});
