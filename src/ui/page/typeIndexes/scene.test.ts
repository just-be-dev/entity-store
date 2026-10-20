import { describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { Command, click, expect, given, label, role, scene, text, type } from "foldkit/scene";
import { apiFailure, emailIndex, personType } from "@/domain/entityStore.fixture";
import { CreateIndex, DropIndex, init, Message, update, view } from "./main.ts";

const withIndexes = (items: Parameters<typeof Message.SucceededFetchIndexes>[0]["items"]) =>
  [
    Message.SucceededFetchType({ info: personType }),
    Message.SucceededFetchIndexes({ items }),
  ].reduce((m, msg) => update(m, msg).model, init("person").model);

describe("type indexes", () => {
  it("lists indexes with their key, version, and state", () => {
    scene(
      { update, view },
      given(
        withIndexes([
          emailIndex(),
          emailIndex({
            name: "nick",
            key: "nickname",
            unique: false,
            state: "failed",
            error: Option.some("entity 'ada': keys must be strings"),
          }),
          emailIndex({ name: "tags", key: "tags", unique: false, state: "building" }),
        ]),
      ),
      expect(role("heading", { name: "Indexes" })).toExist(),
      expect(role("link", { name: "person" })).toHaveAttr("href", "/types/person"),
      expect(text("lower(email)")).toExist(),
      expect(text("unique")).toExist(),
      expect(role("alert")).toContainText("Backfill failed: entity 'ada': keys must be strings"),
      expect(role("button", { name: "Build now" })).toExist(),
      expect(text("Indexing existing entities in the background.", { exact: false })).toExist(),
    );
  });

  it("explains how to start when there are no indexes", () => {
    scene({ update, view }, given(withIndexes([])), expect(text("No indexes")).toExist());
  });

  it("offers the pinned version's fields and creates an index from the form", () => {
    scene(
      { update, view },
      given(withIndexes([])),
      expect(text("Fields at v2:")).toExist(),
      click(role("button", { name: "fullName" })),
      expect(label("Key expression")).toHaveValue("fullName"),
      type(label("Key expression"), "lower(fullName)"),
      click(label("Unique: no two entities may share a key")),
      click(role("button", { name: "Create index" })),
      Command.expectExact(
        CreateIndex({
          type: "person",
          name: "fullName",
          version: 2,
          key: "lower(fullName)",
          unique: true,
        }),
      ),
      Command.resolve(
        CreateIndex,
        Message.SucceededCreateIndex({
          index: emailIndex({ name: "fullName", key: "lower(fullName)", state: "building" }),
        }),
      ),
      expect(role("status")).toContainText(
        "Existing entities are still being indexed in the background.",
      ),
    );
  });

  it("shows why a create was refused", () => {
    scene(
      { update, view },
      given(withIndexes([])),
      type(label("Name"), "bad"),
      type(label("Key expression"), "lower(mail)"),
      click(role("button", { name: "Create index" })),
      Command.resolve(
        CreateIndex,
        Message.FailedCreateIndex({
          failure: apiFailure(422, "InvalidIndex", "The index definition is invalid", {
            issues: [{ path: "key", message: "'mail' isn't a field of v2" }],
          }),
        }),
      ),
      expect(role("alert")).toContainText("'mail' isn't a field of v2"),
    );
  });

  it("drops an index after confirmation", () => {
    scene(
      { update, view },
      given(withIndexes([emailIndex()])),
      click(role("button", { name: "Drop email" })),
      expect(text("Drop this index?")).toExist(),
      click(role("button", { name: "Drop" })),
      Command.resolve(DropIndex, Message.SucceededDropIndex({ name: "email" })),
      expect(text("No indexes")).toExist(),
    );
  });
});
