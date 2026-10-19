import { describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { Command, click, expect, given, role, scene, text, within } from "foldkit/scene";
import { ada, apiFailure, post, postType } from "@/domain/entityStore.fixture";
import { DeleteEntity, FetchBacklinks, init, Message, SaveEntity, update, view } from "./main.ts";

const loaded = [
  Message.SucceededFetchEntity({
    requested: Option.none(),
    entity: post(),
    included: { ada: ada() },
  }),
  Message.SucceededFetchType({ info: postType }),
  Message.SucceededFetchBacklinks({
    page: { items: [{ source: "n1", type: "note", path: "about" }], nextCursor: Option.some("n1") },
  }),
].reduce((m, msg) => update(m, msg).model, init("p1").model);

describe("entity links", () => {
  it("lists outgoing links by path with the target's type and a preview", () => {
    scene(
      { update, view },
      given(loaded),
      expect(within(role("list", { name: "Outgoing links" }), text("author"))).toExist(),
      expect(role("link", { name: "ada" })).toHaveAttr("href", "/entities/ada"),
      expect(text('person · {"fullName":"Ada Lovelace"}')).toExist(),
      expect(text("reviewers[]")).toExist(),
      expect(text("person not found")).toExist(),
    );
  });

  it("lists backlinks with links to their sources", () => {
    scene(
      { update, view },
      given(loaded),
      expect(role("link", { name: "n1" })).toHaveAttr("href", "/entities/n1"),
      expect(text("note · about")).toExist(),
      expect(role("button", { name: "More backlinks" })).toExist(),
    );
  });

  it("shows who links here when a delete is refused", () => {
    scene(
      { update, view },
      given(loaded),
      click(role("button", { name: "Delete entity" })),
      click(role("button", { name: "Yes, delete" })),
      Command.resolve(
        DeleteEntity,
        Message.FailedDeleteEntity({
          failure: apiFailure(409, "EntityLinked", "Entity 'p1' is linked from 1 entity", {
            linkedFrom: [{ source: "n9", type: "note", path: "about" }],
          }),
        }),
      ),
      Command.resolve(
        FetchBacklinks,
        Message.SucceededFetchBacklinks({
          page: {
            items: [{ source: "n9", type: "note", path: "about" }],
            nextCursor: Option.none(),
          },
        }),
      ),
      expect(text("Can't delete: linked from")).toExist(),
      expect(
        within(role("list", { name: "Linked from" }), role("link", { name: "n9" })),
      ).toHaveAttr("href", "/entities/n9"),
    );
  });

  it("shows each invalid link a save was rejected for", () => {
    scene(
      { update, view },
      given(loaded),
      click(role("button", { name: "Save" })),
      Command.resolve(
        SaveEntity,
        Message.FailedSaveEntity({
          failure: apiFailure(422, "LinkTargetInvalid", "Some links are invalid", {
            problems: [
              { path: "author", target: "nobody", message: "no entity 'nobody'" },
              { path: "reviewers[]", target: "p0", message: "'p0' is a post, not a person" },
            ],
          }),
        }),
      ),
      expect(within(role("list", { name: "Invalid links" }), text("nobody"))).toExist(),
      expect(text("'p0' is a post, not a person")).toExist(),
    );
  });
});
