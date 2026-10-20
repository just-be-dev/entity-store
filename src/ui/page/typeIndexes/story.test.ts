import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { Command, given, message, model, story } from "foldkit/story";
import { modifyFields } from "foldkit/struct";
import { apiFailure, emailIndex, personType } from "@/domain/entityStore.fixture";
import {
  Action,
  BuildIndex,
  CreateIndex,
  Creation,
  DropIndex,
  FetchIndexes,
  FetchType,
  Indexes,
  init,
  Message,
  update,
} from "./main.ts";

const initial = init("person");
const loaded = [
  Message.SucceededFetchType({ info: personType }),
  Message.SucceededFetchIndexes({ items: [emailIndex()] }),
].reduce((m, msg) => update(m, msg).model, initial.model);

const names = (indexes: Indexes) =>
  indexes._tag === "Loaded" ? indexes.items.map((index) => index.name) : [];

describe("type indexes", () => {
  it("fetches the type and its indexes, pinning new indexes to the latest version", () => {
    expect(initial.commands?.map((c) => c.name)).toEqual([FetchType.name, FetchIndexes.name]);
    story(
      update,
      given(initial.model),
      message(Message.SucceededFetchType({ info: personType })),
      model((m) => expect(m.version).toEqual(Option.some(2))),
    );
  });

  it("asks for a name and key before creating", () => {
    story(
      update,
      given(loaded),
      message(Message.SubmittedNewIndex()),
      model((m) =>
        expect(m.creation).toEqual(Creation.Invalid({ message: "Give the index a name." })),
      ),
      message(Message.UpdatedIndexName({ value: "name" })),
      message(Message.SubmittedNewIndex()),
      model((m) => expect(m.creation._tag).toBe("Invalid")),
      Command.expectNone(),
    );
  });

  it("creates an index with the form's settings and adds it to the list", () => {
    const created = emailIndex({ name: "byName", key: "lower(fullName)", unique: false });
    story(
      update,
      given(loaded),
      message(Message.ClickedUseField({ field: "fullName" })),
      model((m) => {
        expect(m.keyText).toBe("fullName");
        expect(m.nameText).toBe("fullName");
      }),
      message(Message.UpdatedIndexName({ value: " byName " })),
      message(Message.UpdatedIndexKey({ value: "lower(fullName)" })),
      message(Message.SelectedIndexVersion({ version: 1 })),
      message(Message.ToggledUnique()),
      message(Message.ToggledUnique()),
      message(Message.SubmittedNewIndex()),
      Command.expectExact(
        CreateIndex({
          type: "person",
          name: "byName",
          version: 1,
          key: "lower(fullName)",
          unique: false,
        }),
      ),
      Command.resolve(CreateIndex, Message.SucceededCreateIndex({ index: created })),
      model((m) => {
        expect(m.creation).toEqual(Creation.Created({ index: created }));
        expect(names(m.indexes)).toEqual(["byName", "email"]);
        expect(m.nameText).toBe("");
        expect(m.keyText).toBe("");
      }),
    );
  });

  it("confirms before dropping, then removes the index", () => {
    story(
      update,
      given(loaded),
      message(Message.ClickedDropIndex({ name: "email" })),
      model((m) => expect(m.action).toEqual(Action.ConfirmingDrop({ name: "email" }))),
      Command.expectNone(),
      message(Message.ClickedCancelDrop()),
      model((m) => expect(m.action).toEqual(Action.Idle())),
      message(Message.ClickedDropIndex({ name: "email" })),
      message(Message.ClickedConfirmDrop({ name: "email" })),
      Command.expectExact(DropIndex({ type: "person", name: "email" })),
      Command.resolve(DropIndex, Message.SucceededDropIndex({ name: "email" })),
      model((m) => {
        expect(names(m.indexes)).toEqual([]);
        expect(m.action).toEqual(Action.Idle());
      }),
    );
  });

  it("builds a building index on demand and shows its new state", () => {
    const building = update(
      loaded,
      Message.SucceededFetchIndexes({ items: [emailIndex({ state: "building" })] }),
    ).model;
    const failure = apiFailure(500, "StorageFailure", "Storage error");
    story(
      update,
      given(building),
      message(Message.ClickedBuildIndex({ name: "email" })),
      Command.expectExact(BuildIndex({ type: "person", name: "email" })),
      model((m) => expect(m.action).toEqual(Action.Building({ name: "email" }))),
      Command.resolve(BuildIndex, Message.FailedBuildIndex({ name: "email", failure })),
      model((m) => expect(m.action).toEqual(Action.Failed({ name: "email", failure }))),
      message(Message.ClickedBuildIndex({ name: "email" })),
      Command.resolve(BuildIndex, Message.SucceededBuildIndex({ index: emailIndex() })),
      model((m) => {
        expect(m.indexes._tag === "Loaded" && m.indexes.items[0]?.state).toBe("ready");
        expect(m.action).toEqual(Action.Idle());
      }),
    );
  });

  it("ignores other index actions while one is in flight", () => {
    const busy = modifyFields(loaded, { action: () => Action.Building({ name: "email" }) });
    story(
      update,
      given(busy),
      message(Message.ClickedDropIndex({ name: "email" })),
      message(Message.ClickedBuildIndex({ name: "email" })),
      model((m) => expect(m).toEqual(busy)),
      Command.expectNone(),
    );
  });
});
