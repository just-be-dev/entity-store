import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { Command, given, message, model, story } from "foldkit/story";
import { ada, apiFailure, personType } from "@/domain/entityStore.fixture";
import { Dialog } from "@foldkit/ui";
import { expectOutMessage } from "foldkit/story";
import { Submission } from "@/components/confirm";
import {
  DeleteEntity,
  Entities,
  FetchBacklinks,
  FetchUsage,
  OutMessage,
  FetchEntities,
  FetchIndexes,
  FetchMoreEntities,
  FetchType,
  init,
  Message,
  More,
  update,
} from "./index.ts";

const initial = init("person");
const loaded = update(initial.model, Message.SucceededFetchType({ info: personType })).model;

const page = (ids: ReadonlyArray<string>, nextCursor: Option.Option<string>) => ({
  items: ids.map((id) => ada({ id })),
  failures: [],
  nextCursor,
});

describe("type detail", () => {
  it("fetches the type, then its entities at the latest version", () => {
    expect(initial.commands?.map((c) => c.name)).toEqual([FetchType.name, FetchIndexes.name]);
    story(
      update,
      given(initial.model),
      message(Message.SucceededFetchType({ info: personType })),
      model((m) => {
        expect(m.readVersion).toEqual(Option.some(2));
        expect(m.writeVersion).toEqual(Option.some(2));
        expect(m.entities).toEqual(Entities.Loading({ version: 2 }));
      }),
      Command.expectExact(FetchEntities({ name: "person", version: 2 })),
      Command.resolve(
        FetchEntities,
        Message.SucceededFetchEntities({ version: 2, page: page(["ada"], Option.some("ada")) }),
      ),
      model((m) => expect(m.entities._tag).toBe("Loaded")),
    );
  });

  it("ignores a page for a version the user has moved away from", () => {
    story(
      update,
      given(loaded),
      message(Message.SelectedReadVersion({ version: 1 })),
      Command.resolve(
        FetchEntities,
        Message.SucceededFetchEntities({ version: 2, page: page(["late"], Option.none()) }),
      ),
      model((m) => expect(m.entities).toEqual(Entities.Loading({ version: 1 }))),
      message(Message.SucceededFetchEntities({ version: 1, page: page(["ada"], Option.none()) })),
      model((m) => {
        expect(m.entities._tag === "Loaded" && m.entities.items.map((e) => e.id)).toEqual(["ada"]);
      }),
    );
  });

  it("appends the next page with the cursor", () => {
    const withFirstPage = update(
      loaded,
      Message.SucceededFetchEntities({ version: 2, page: page(["a", "b"], Option.some("b")) }),
    ).model;
    story(
      update,
      given(withFirstPage),
      message(Message.ClickedLoadMore()),
      Command.expectExact(FetchMoreEntities({ name: "person", version: 2, cursor: "b" })),
      model((m) => expect(m.entities._tag === "Loaded" && m.entities.more).toEqual(More.Loading())),
      Command.resolve(
        FetchMoreEntities,
        Message.SucceededFetchMoreEntities({ version: 2, page: page(["c"], Option.none()) }),
      ),
      model((m) => {
        expect(m.entities._tag === "Loaded" && m.entities.items.map((e) => e.id)).toEqual([
          "a",
          "b",
          "c",
        ]);
        expect(m.entities._tag === "Loaded" && m.entities.nextCursor).toEqual(Option.none());
      }),
    );
  });

  it("merges linked entities across pages", () => {
    const first = update(
      loaded,
      Message.SucceededFetchEntities({
        version: 2,
        page: { ...page(["a"], Option.some("a")), included: { x: ada({ id: "x" }) } },
      }),
    ).model;
    story(
      update,
      given(first),
      message(Message.ClickedLoadMore()),
      Command.resolve(
        FetchMoreEntities,
        Message.SucceededFetchMoreEntities({
          version: 2,
          page: { ...page(["b"], Option.none()), included: { y: ada({ id: "y" }) } },
        }),
      ),
      model((m) => {
        expect(m.entities._tag === "Loaded" && Object.keys(m.entities.included)).toEqual([
          "x",
          "y",
        ]);
      }),
    );
  });

  it("re-forms the new entity at the write version", () => {
    story(
      update,
      given(loaded),
      model((m) =>
        expect(Option.map(m.maybeNewEntity, (form) => form.version)).toEqual(Option.some(2)),
      ),
      message(Message.SelectedWriteVersion({ version: 1 })),
      model((m) => {
        expect(m.writeVersion).toEqual(Option.some(1));
        expect(Option.map(m.maybeNewEntity, (form) => Object.keys(form.values))).toEqual(
          Option.some(["firstName", "lastName", "nickname"]),
        );
      }),
    );
  });

  it("ignores confirming while a write is in flight, or while it's refused", () => {
    const withRow = update(
      loaded,
      Message.SucceededFetchEntities({ version: 2, page: page(["ada"], Option.none()) }),
    ).model;
    story(
      update,
      given(withRow),
      message(Message.ClickedDeleteRow({ id: "ada" })),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      Command.resolve(
        FetchUsage,
        Message.FailedFetchUsage({ failure: apiFailure(0, "x", "offline") }),
      ),
      model((m) => expect(update(m, Message.ClickedConfirm()).commands ?? []).toEqual([])),
      Command.resolve(
        FetchBacklinks,
        Message.SucceededFetchBacklinks({
          id: "ada",
          page: {
            items: [{ source: "p1", type: "post", path: "author" }],
            nextCursor: Option.some("p1"),
          },
        }),
      ),
      model((m) =>
        expect(Option.map(m.maybePending, (pending) => pending.proposal.refusals)).toEqual(
          Option.some([
            "Other entities link to it: p1 (post, author), and more. Remove those links first.",
          ]),
        ),
      ),
      model((m) => expect(update(m, Message.ClickedConfirm()).commands ?? []).toEqual([])),
    );
  });

  it("drops a pending write when the dialog closes, and keeps it while the write runs", () => {
    const withRow = update(
      loaded,
      Message.SucceededFetchEntities({ version: 2, page: page(["ada"], Option.none()) }),
    ).model;
    story(
      update,
      given(withRow),
      message(Message.ClickedDeleteRow({ id: "ada" })),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      Command.resolve(
        FetchUsage,
        Message.FailedFetchUsage({ failure: apiFailure(0, "x", "offline") }),
      ),
      Command.resolve(
        FetchBacklinks,
        Message.SucceededFetchBacklinks({
          id: "ada",
          page: { items: [], nextCursor: Option.none() },
        }),
      ),
      message(Message.ClickedConfirm()),
      model((m) => {
        expect(m.submission).toEqual(Submission.Working());
        const closed = update(
          m,
          Message.GotDialogMessage({ message: Dialog.Message.RequestedClose() }),
        );
        expect(Option.isSome(closed.model.maybePending)).toBe(true);
      }),
      Command.resolve(
        DeleteEntity,
        Message.FailedWrite({ failure: apiFailure(409, "RevConflict", "stale") }),
      ),
      model((m) => expect(m.submission._tag).toBe("Failed")),
    );
  });

  it("tells the root the type list changed after a version or a delete", () => {
    story(
      update,
      given(loaded),
      message(Message.SucceededAddVersion({ version: 3 })),
      expectOutMessage(OutMessage.ChangedTypes()),
      Command.resolve(FetchType, Message.SucceededFetchType({ info: personType })),
      Command.resolve(
        FetchEntities,
        Message.SucceededFetchEntities({ version: 2, page: page([], Option.none()) }),
      ),
    );
  });
});
