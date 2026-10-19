import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { Command, given, message, model, story } from "foldkit/story";
import { ada, apiFailure, personType, revision } from "@/domain/entityStore.fixture";
import {
  DeleteEntity,
  Deletion,
  Editor,
  EntityState,
  FetchBacklinks,
  FetchEditBase,
  FetchEntity,
  FetchHistory,
  FetchMoreBacklinks,
  FetchMoreHistory,
  FetchType,
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
  Message.SucceededFetchEntity({ requested: Option.none(), entity: ada(), included: {} }),
  Message.SucceededFetchHistory({
    requested: Option.none(),
    page: historyPage([3, 2], Option.some(2)),
  }),
].reduce((m, msg) => update(m, msg).model, initial.model);

describe("entity detail", () => {
  it("loads the entity and its history, learning the latest version and seeding the editor", () => {
    expect(initial.commands?.map((c) => c.name)).toEqual([
      FetchEntity.name,
      FetchHistory.name,
      FetchBacklinks.name,
    ]);
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
          included: {},
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
        Message.SucceededFetchEntity({
          requested: Option.none(),
          entity: ada({ rev: 99 }),
          included: {},
        }),
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
        Message.SucceededFetchEntity({
          requested: Option.none(),
          entity: ada({ rev: 4 }),
          included: {},
        }),
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
        FetchBacklinks({ id: "ada" }),
        FetchEditBase({ id: "ada", version: 2 }),
      ),
      Command.resolve(
        FetchBacklinks,
        Message.SucceededFetchBacklinks({ page: { items: [], nextCursor: Option.none() } }),
      ),
      Command.resolve(
        FetchEditBase,
        Message.SucceededFetchEditBase({
          entity: ada({ rev: 5, data: { fullName: "Someone Else" } }),
        }),
      ),
      Command.resolve(
        FetchEntity,
        Message.SucceededFetchEntity({
          requested: Option.none(),
          entity: ada({ rev: 5 }),
          included: {},
        }),
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
      Command.expectExact(FetchType({ name: "person" })),
      Command.resolve(FetchType, Message.SucceededFetchType({ info: personType })),
    );
  });

  it("fetches the type once, for link fields and the latest version", () => {
    story(
      update,
      given(initial.model),
      message(
        Message.SucceededFetchEntity({ requested: Option.none(), entity: ada(), included: {} }),
      ),
      Command.expectExact(FetchType({ name: "person" })),
      Command.resolve(
        FetchType,
        Message.SucceededFetchType({ info: { ...personType, latestVersion: 3 } }),
      ),
      message(
        Message.SucceededFetchHistory({
          requested: Option.none(),
          page: historyPage([3], Option.none()),
        }),
      ),
      Command.expectNone(),
      model((m) => {
        expect(m.type._tag).toBe("Loaded");
        expect(m.latestVersion).toEqual(Option.some(3));
      }),
    );
  });

  it("pages through backlinks", () => {
    const withBacklinks = update(
      loaded,
      Message.SucceededFetchBacklinks({
        page: {
          items: [{ source: "p1", type: "post", path: "author" }],
          nextCursor: Option.some("p1"),
        },
      }),
    ).model;
    story(
      update,
      given(withBacklinks),
      message(Message.ClickedLoadMoreBacklinks()),
      Command.expectExact(FetchMoreBacklinks({ id: "ada", cursor: "p1" })),
      Command.resolve(
        FetchMoreBacklinks,
        Message.SucceededFetchMoreBacklinks({
          page: {
            items: [{ source: "p2", type: "post", path: "reviewers[]" }],
            nextCursor: Option.none(),
          },
        }),
      ),
      model((m) => {
        expect(m.backlinks._tag === "Loaded" && m.backlinks.items.map((b) => b.source)).toEqual([
          "p1",
          "p2",
        ]);
      }),
    );
  });

  it("refreshes backlinks when a delete is refused because the entity is linked", () => {
    story(
      update,
      given(update(loaded, Message.ClickedDelete()).model),
      message(Message.ClickedConfirmDelete()),
      Command.resolve(
        DeleteEntity,
        Message.FailedDeleteEntity({
          failure: apiFailure(409, "EntityLinked", "Entity 'ada' is linked", {
            linkedFrom: [{ source: "p1", type: "post", path: "author" }],
          }),
        }),
      ),
      model((m) => expect(m.deletion._tag).toBe("Failed")),
      Command.expectExact(FetchBacklinks({ id: "ada" })),
      Command.resolve(
        FetchBacklinks,
        Message.SucceededFetchBacklinks({
          page: {
            items: [{ source: "p1", type: "post", path: "author" }],
            nextCursor: Option.none(),
          },
        }),
      ),
    );
  });
});
