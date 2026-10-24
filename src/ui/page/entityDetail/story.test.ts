import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { Command, given, message, model, story } from "foldkit/story";
import { ada, apiFailure, personType, revision } from "@/domain/entityStore.fixture";
import { Dialog } from "@foldkit/ui";
import { Submission } from "@/components/confirm";
import * as EntityForm from "@/components/entityForm/main";
import {
  DeleteEntity,
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
  FetchUsage,
  NavigateToType,
  update,
  WriteEntity,
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
const withType = update(loaded, Message.SucceededFetchType({ info: personType })).model;
const editor = (formMessage: EntityForm.Message) =>
  message(Message.GotEditorMessage({ message: formMessage }));
const offline = apiFailure(0, "x", "offline");

describe("entity detail", () => {
  it("loads the entity and its history, learning the latest version and seeding the editor", () => {
    expect(initial.commands?.map((c) => c.name)).toEqual([
      FetchEntity.name,
      FetchHistory.name,
      FetchBacklinks.name,
    ]);
    expect(loaded.latestVersion).toEqual(Option.some(2));
    expect(loaded.editor).toEqual(Editor.Waiting({ entity: ada() }));
    expect(withType.editor._tag === "Editing" && withType.editor.form.values).toEqual({
      fullName: "Ada Lovelace",
      age: "",
    });
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
        expect(m.editor._tag === "Waiting" && m.editor.entity.version).toBe(2);
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

  it("confirms a save, writes it with the writer's version and expected rev, then reloads", () => {
    story(
      update,
      given(withType),
      editor(EntityForm.Message.UpdatedField({ name: "fullName", value: "Augusta King" })),
      editor(EntityForm.Message.SubmittedForm()),
      Command.resolve(
        EntityForm.CheckWrite,
        EntityForm.Message.SucceededCheckWrite({
          check: { data: { fullName: "Augusta King" }, version: 2, created: false },
        }),
      ),
      model((m) => expect(m.dialog.isOpen).toBe(true)),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      Command.resolve(FetchUsage, Message.FailedFetchUsage({ failure: offline })),
      message(Message.ClickedConfirm()),
      Command.expectExact(
        WriteEntity({
          write: EntityForm.PreparedWrite.Upsert({
            type: "person",
            id: "ada",
            version: 2,
            patch: { fullName: "Augusta King" },
            expectedRev: 3,
            before: { fullName: "Ada Lovelace" },
            after: { fullName: "Augusta King" },
            created: false,
          }),
        }),
      ),
      Command.resolve(
        WriteEntity,
        Message.SucceededSaveEntity({
          entity: ada({ rev: 4, data: { fullName: "Augusta King" } }),
        }),
      ),
      model((m) => {
        expect(m.maybeNotice).toEqual(Option.some("Saved as rev 4."));
        expect(m.editor._tag === "Editing" && m.editor.form.values["fullName"]).toBe(
          "Augusta King",
        );
      }),
      Command.resolve(Dialog.CloseDialog, Dialog.Message.CompletedCloseDialog()),
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

  it("keeps a stale-rev rejection in the dialog, and reload gets the other writer's data", () => {
    story(
      update,
      given(withType),
      editor(EntityForm.Message.UpdatedField({ name: "age", value: "37" })),
      editor(EntityForm.Message.SubmittedForm()),
      Command.resolve(
        EntityForm.CheckWrite,
        EntityForm.Message.SucceededCheckWrite({
          check: { data: { fullName: "Ada Lovelace", age: 37 }, version: 2, created: false },
        }),
      ),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      Command.resolve(FetchUsage, Message.FailedFetchUsage({ failure: offline })),
      message(Message.ClickedConfirm()),
      Command.resolve(
        WriteEntity,
        Message.FailedWrite({
          failure: apiFailure(409, "RevConflict", "Entity 'ada' is at rev 5, not 3", {
            currentRev: Option.some(5),
          }),
        }),
      ),
      model((m) => expect(m.submission._tag).toBe("Failed")),
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
        expect(m.editor._tag === "Editing" && m.editor.form.mode).toEqual(
          EntityForm.Mode.Edit({ id: "ada", rev: 5, data: { fullName: "Someone Else" } }),
        );
      }),
    );
  });

  it("loads the editor in another writer version", () => {
    story(
      update,
      given(withType),
      message(Message.SelectedWriteVersion({ version: 1 })),
      model((m) => expect(m.editor).toEqual(Editor.Loading({ version: 1 }))),
      Command.resolve(
        FetchEditBase,
        Message.SucceededFetchEditBase({
          entity: ada({ version: 1, data: { firstName: "Ada", lastName: "Lovelace" } }),
        }),
      ),
      model((m) => {
        expect(m.editor._tag === "Editing" && m.editor.form.version).toBe(1);
        expect(m.editor._tag === "Editing" && m.editor.form.values).toEqual({
          firstName: "Ada",
          lastName: "Lovelace",
          nickname: "",
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
      given(withType),
      message(Message.ClickedDelete()),
      model((m) => expect(m.dialog.isOpen).toBe(true)),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      Command.resolve(FetchUsage, Message.FailedFetchUsage({ failure: offline })),
      Command.resolve(
        FetchBacklinks,
        Message.SucceededFetchBacklinks({ page: { items: [], nextCursor: Option.none() } }),
      ),
      message(Message.ClickedConfirm()),
      Command.expectExact(DeleteEntity({ id: "ada", type: "person", expectedRev: 3 })),
      Command.resolve(DeleteEntity, Message.SucceededDeleteEntity({ type: "person" })),
      Command.resolve(Dialog.CloseDialog, Dialog.Message.CompletedCloseDialog()),
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

  it("refuses a delete while something links here, and refreshes backlinks if the API refuses", () => {
    story(
      update,
      given(withType),
      message(Message.ClickedDelete()),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      Command.resolve(FetchUsage, Message.FailedFetchUsage({ failure: offline })),
      model((m) => expect(update(m, Message.ClickedConfirm()).commands ?? []).toEqual([])),
      Command.resolve(
        FetchBacklinks,
        Message.SucceededFetchBacklinks({
          page: {
            items: [{ source: "p1", type: "post", path: "author" }],
            nextCursor: Option.none(),
          },
        }),
      ),
      model((m) => expect(update(m, Message.ClickedConfirm()).commands ?? []).toEqual([])),
      message(
        Message.FailedWrite({
          failure: apiFailure(409, "EntityLinked", "Entity 'ada' is linked", {
            linkedFrom: [{ source: "p1", type: "post", path: "author" }],
          }),
        }),
      ),
      model((m) => expect(m.submission._tag).toBe("Failed")),
      Command.expectExact(FetchBacklinks({ id: "ada" })),
      Command.resolve(
        FetchBacklinks,
        Message.SucceededFetchBacklinks({ page: { items: [], nextCursor: Option.none() } }),
      ),
      model((m) => expect(m.submission).not.toEqual(Submission.Working())),
    );
  });
});
