import { describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { Command, click, expect, given, label, role, scene, text, type } from "foldkit/scene";
import { ada, apiFailure, revision } from "@/domain/entityStore.fixture";
import { init, Message, SaveEntity, update, view } from "./main.ts";

const loaded = [
  Message.SucceededFetchEntity({ requested: Option.none(), entity: ada(), included: {} }),
  Message.SucceededFetchHistory({
    requested: Option.none(),
    page: {
      id: "ada",
      type: "person",
      items: [revision(3, "patch"), revision(1, "create")],
      failures: [{ rev: 2, error: "Lens failed near v2" }],
      nextBefore: Option.none(),
    },
  }),
].reduce((m, msg) => update(m, msg).model, init("ada").model);

describe("entity detail", () => {
  it("shows the entity's facts, data, and history", () => {
    scene(
      { update, view },
      given(loaded),
      expect(role("heading", { name: "ada" })).toExist(),
      expect(role("link", { name: "person" })).toHaveAttr("href", "/types/person"),
      expect(text("Stored as")).toExist(),
      expect(label("Show as")).toHaveValue("2"),
      expect(text("rev 3")).toExist(),
      expect(text("written as v1 · stored v1")).toExist(),
      expect(text("rev 2 can't be shown at this version: Lens failed near v2")).toExist(),
    );
  });

  it("explains a conflicting save and offers a reload", () => {
    scene(
      { update, view },
      given(loaded),
      type(label("Data as v2 (JSON)"), '{"fullName":"Augusta King"}'),
      click(role("button", { name: "Save" })),
      expect(role("button", { name: "Saving…" })).toBeDisabled(),
      Command.resolve(
        SaveEntity,
        Message.FailedSaveEntity({
          failure: apiFailure(409, "RevConflict", "Entity 'ada' is at rev 5, not 3", {
            currentRev: Option.some(5),
          }),
        }),
      ),
      expect(role("alert")).toContainText("Someone else edited this entity (now at rev 5)"),
      expect(role("button", { name: "Reload" })).toExist(),
    );
  });

  it("asks for confirmation before deleting", () => {
    scene(
      { update, view },
      given(loaded),
      click(role("button", { name: "Delete entity" })),
      expect(text("Delete this entity? Its history is kept.")).toExist(),
      click(role("button", { name: "Cancel" })),
      expect(role("button", { name: "Delete entity" })).toExist(),
    );
  });

  it("shows a deleted entity's error", () => {
    scene(
      { update, view },
      given(
        update(
          init("ada").model,
          Message.FailedFetchEntity({
            requested: Option.none(),
            failure: apiFailure(410, "EntityDeleted", "Entity 'ada' was deleted at rev 4"),
          }),
        ).model,
      ),
      expect(role("alert")).toContainText("Entity 'ada' was deleted at rev 4"),
      expect(role("button", { name: "Save" })).toBeAbsent(),
    );
  });
});
