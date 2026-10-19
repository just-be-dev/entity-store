import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { Command, given, message, model, story } from "foldkit/story";
import { ada, apiFailure, revision } from "@/domain/entityStore.fixture";
import {
  DeleteEntity,
  Deletion,
  Editor,
  EntityState,
  FetchEditBase,
  FetchEntity,
  FetchHistory,
  FetchMoreHistory,
  init,
  Message,
  NavigateToType,
  Save,
  SaveEntity,
  update,
} from "./main.ts";

const initial = init("ada");
const historyPage = (revs: ReadonlyArray<number>, nextBefore: Option.Option<number>) => ({
  id: "ada",
  type: "person",
  items: revs.map((rev) => revision(rev, rev === 1 ? "create" : "patch")),
  failures: [],
  nextBefore,
});
const loaded = [
  Message.SucceededFetchEntity({ requested: Option.none(), entity: ada() }),
  Message.SucceededFetchHistory({
    requested: Option.none(),
    page: historyPage([3, 2], Option.some(2)),
  }),
].reduce((m, msg) => update(m, msg).model, initial.model);

describe("entity detail", () => {
  it("loads the entity and its history, learning the latest version and seeding the editor", () => {
    expect(initial.commands?.map((c) => c.name)).toEqual([FetchEntity.name, FetchHistory.name]);
    expect(loaded.latestVersion).toEqual(Option.some(2));
    expect(loaded.editor).toEqual(
      Editor.Editing({
        version: 2,
        baseRev: 3,
        text: '{\n  "fullName": "Ada Lovelace"\n}',
        save: Save.Idle(),
      }),
    );
  });

  it("re-reads entity and history when the presented version changes", () => {
    story(
      update,
      given(loaded),
      message(Message.SelectedPresentVersion({ version: 1 })),
      Command.expectExact(
        FetchEntity({ id: "ada", version: Option.some(1) }),
        FetchHistory({ id: "ada", version: Option.some(1) }),
      ),
      Command.resolve(
        FetchEntity,
        Message.SucceededFetchEntity({
          requested: Option.some(1),
          entity: ada({ version: 1, data: { firstName: "Ada", lastName: "Lovelace" } }),
        }),
      ),
      Command.resolve(
        FetchHistory,
        Message.SucceededFetchHistory({
          requested: Option.some(1),
          page: historyPage([3], Option.none()),
        }),
      ),
      model((m) => {
        expect(m.entity._tag === "Loaded" && m.entity.entity.version).toBe(1);
        expect(m.latestVersion).toEqual(Option.some(2));
        expect(m.editor._tag === "Editing" && m.editor.version).toBe(2);
      }),
    );
  });

  it("ignores a response for a version that is no longer shown", () => {
    story(
      update,
      given(loaded),
      message(Message.SelectedPresentVersion({ version: 1 })),
      Command.resolve(
        FetchEntity,
        Message.SucceededFetchEntity({ requested: Option.none(), entity: ada({ rev: 99 }) }),
      ),
      Command.resolve(
        FetchHistory,
        Message.FailedFetchHistory({
          requested: Option.none(),
          failure: apiFailure(500, "StorageFailure", "x"),
        }),
      ),
      model((m) => {
        expect(m.entity).toEqual(EntityState.Loading());
        expect(m.history._tag).toBe("Loading");
      }),
    );
  });

  it("saves with the writer's version and expected rev, then reloads", () => {
    story(
      update,
      given(loaded),
      message(Message.UpdatedEditText({ value: '{"fullName":"Augusta King"}' })),
      message(Message.ClickedSave()),
      Command.expectExact(
        SaveEntity({ id: "ada", version: 2, data: { fullName: "Augusta King" }, expectedRev: 3 }),
      ),
      Command.resolve(
        SaveEntity,
        Message.SucceededSaveEntity({
          entity: ada({ rev: 4, data: { fullName: "Augusta King" } }),
        }),
      ),
      model((m) => {
        expect(m.editor._tag === "Editing" && m.editor.baseRev).toBe(4);
        expect(m.editor._tag === "Editing" && m.editor.save).toEqual(Save.Saved({ rev: 4 }));
      }),
      Command.expectExact(
        FetchEntity({ id: "ada", version: Option.none() }),
        FetchHistory({ id: "ada", version: Option.none() }),
      ),
      Command.resolve(
        FetchEntity,
        Message.SucceededFetchEntity({ requested: Option.none(), entity: ada({ rev: 4 }) }),
      ),
      Command.resolve(
        FetchHistory,
        Message.SucceededFetchHistory({
          requested: Option.none(),
          page: historyPage([4, 3], Option.some(3)),
        }),
      ),
    );
  });

  it("turns a stale-rev rejection into a conflict that reload resolves", () => {
    story(
      update,
      given(loaded),
      message(Message.ClickedSave()),
      Command.resolve(
        SaveEntity,
        Message.FailedSaveEntity({
          failure: apiFailure(409, "RevConflict", "Entity 'ada' is at rev 5, not 3", {
            currentRev: Option.some(5),
          }),
        }),
      ),
      model((m) => {
        expect(m.editor._tag === "Editing" && m.editor.save).toEqual(
          Save.Conflict({ currentRev: Option.some(5) }),
        );
      }),
      message(Message.ClickedReload()),
      Command.expectExact(
        FetchEntity({ id: "ada", version: Option.none() }),
        FetchHistory({ id: "ada", version: Option.none() }),
        FetchEditBase({ id: "ada", version: 2 }),
      ),
      Command.resolve(
        FetchEditBase,
        Message.SucceededFetchEditBase({
          entity: ada({ rev: 5, data: { fullName: "Someone Else" } }),
        }),
      ),
      Command.resolve(
        FetchEntity,
        Message.SucceededFetchEntity({ requested: Option.none(), entity: ada({ rev: 5 }) }),
      ),
      Command.resolve(
        FetchHistory,
        Message.SucceededFetchHistory({
          requested: Option.none(),
          page: historyPage([5], Option.none()),
        }),
      ),
      model((m) => {
        expect(m.editor._tag === "Editing" && m.editor.baseRev).toBe(5);
        expect(m.editor._tag === "Editing" && m.editor.save).toEqual(Save.Idle());
      }),
    );
  });

  it("loads the editor in another writer version", () => {
    story(
      update,
      given(loaded),
      message(Message.SelectedWriteVersion({ version: 1 })),
      model((m) => expect(m.editor).toEqual(Editor.Loading({ version: 1 }))),
      Command.resolve(
        FetchEditBase,
        Message.SucceededFetchEditBase({
          entity: ada({ version: 1, data: { firstName: "Ada", lastName: "Lovelace" } }),
        }),
      ),
      model((m) => {
        expect(m.editor._tag === "Editing" && m.editor.version).toBe(1);
        expect(m.editor._tag === "Editing" && JSON.parse(m.editor.text)).toEqual({
          firstName: "Ada",
          lastName: "Lovelace",
        });
      }),
    );
  });

  it("appends older history", () => {
    story(
      update,
      given(loaded),
      message(Message.ClickedLoadMoreHistory()),
      Command.expectExact(FetchMoreHistory({ id: "ada", version: Option.none(), before: 2 })),
      Command.resolve(
        FetchMoreHistory,
        Message.SucceededFetchMoreHistory({
          requested: Option.none(),
          page: historyPage([1], Option.none()),
        }),
      ),
      model((m) => {
        expect(m.history._tag === "Loaded" && m.history.items.map((r) => r.rev)).toEqual([3, 2, 1]);
      }),
    );
  });

  it("confirms before deleting, then goes back to the type", () => {
    story(
      update,
      given(loaded),
      message(Message.ClickedDelete()),
      Command.expectNone(),
      model((m) => expect(m.deletion).toEqual(Deletion.Confirming())),
      message(Message.ClickedConfirmDelete()),
      Command.expectExact(DeleteEntity({ id: "ada", type: "person", expectedRev: 3 })),
      Command.resolve(DeleteEntity, Message.SucceededDeleteEntity({ type: "person" })),
      Command.expectExact(NavigateToType({ name: "person" })),
      Command.resolve(NavigateToType, Message.CompletedNavigateToType()),
    );
  });

  it("learns the type and latest version from history when the entity was deleted", () => {
    story(
      update,
      given(initial.model),
      message(
        Message.FailedFetchEntity({
          requested: Option.none(),
          failure: apiFailure(410, "EntityDeleted", "Entity 'ada' was deleted at rev 4"),
        }),
      ),
      message(
        Message.SucceededFetchHistory({
          requested: Option.none(),
          page: historyPage([4, 3], Option.none()),
        }),
      ),
      model((m) => {
        expect(m.latestVersion).toEqual(Option.some(2));
        expect(m.editor).toEqual(Editor.Idle());
      }),
    );
  });
});
