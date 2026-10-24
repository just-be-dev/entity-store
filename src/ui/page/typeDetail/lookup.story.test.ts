import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { Command, given, message, model, story } from "foldkit/story";
import { ada, apiFailure, emailIndex, personType } from "@/domain/entityStore.fixture";
import {
  FetchEntities,
  init,
  LOOKUP_LIMIT,
  LookUpEntities,
  Lookup,
  Message,
  update,
} from "./index.ts";

const loaded = [
  Message.SucceededFetchType({ info: personType }),
  Message.SucceededFetchEntities({
    version: 2,
    page: { items: [ada()], failures: [], nextCursor: Option.none() },
  }),
].reduce((m, msg) => update(m, msg).model, init("person").model);

const withIndexes = update(
  loaded,
  Message.SucceededFetchIndexes({
    items: [
      emailIndex({ name: "building", state: "building" }),
      emailIndex(),
      emailIndex({ name: "nick", key: "nickname", unique: false }),
    ],
  }),
).model;

const found = (ids: ReadonlyArray<string>) => ({
  items: ids.map((id) => ada({ id })),
  failures: [],
  nextCursor: Option.none(),
});

describe("type detail lookup", () => {
  it("selects the first ready index for lookups", () => {
    expect(withIndexes.lookupIndex).toEqual(Option.some("email"));
    const keptSelection = update(
      update(withIndexes, Message.SelectedLookupIndex({ name: "nick" })).model,
      Message.SucceededFetchIndexes({ items: [emailIndex(), emailIndex({ name: "nick" })] }),
    ).model;
    expect(keptSelection.lookupIndex).toEqual(Option.some("nick"));
  });

  it("looks entities up by the selected index and the exact key", () => {
    story(
      update,
      given(withIndexes),
      message(Message.SubmittedLookup()),
      Command.expectNone(),
      message(Message.UpdatedLookupKey({ value: "ada@example.com" })),
      message(Message.SubmittedLookup()),
      Command.expectExact(
        LookUpEntities({ name: "person", index: "email", key: "ada@example.com", version: 2 }),
      ),
      model((m) =>
        expect(m.lookup).toEqual(
          Lookup.Loading({ index: "email", key: "ada@example.com", version: 2 }),
        ),
      ),
      Command.resolve(
        LookUpEntities,
        Message.SucceededLookup({
          index: "email",
          key: "ada@example.com",
          version: 2,
          page: found(["ada"]),
        }),
      ),
      model((m) => {
        expect(m.lookup._tag === "Loaded" && m.lookup.items.map((e) => e.id)).toEqual(["ada"]);
      }),
      message(Message.ClickedClearLookup()),
      model((m) => expect(m.lookup).toEqual(Lookup.Off())),
    );
    expect(LOOKUP_LIMIT).toBe(200);
  });

  it("re-runs an active lookup when the read version changes", () => {
    const active = update(
      update(withIndexes, Message.UpdatedLookupKey({ value: "a" })).model,
      Message.SubmittedLookup(),
    ).model;
    story(
      update,
      given(active),
      message(Message.SelectedReadVersion({ version: 1 })),
      Command.expectHas(FetchEntities({ name: "person", version: 1 })),
      Command.expectHas(LookUpEntities({ name: "person", index: "email", key: "a", version: 1 })),
      Command.resolve(
        FetchEntities,
        Message.SucceededFetchEntities({ version: 1, page: found([]) }),
      ),
      Command.resolve(
        LookUpEntities,
        Message.FailedLookup({
          index: "email",
          key: "a",
          version: 1,
          failure: apiFailure(409, "IndexNotReady", "Index 'email' is still building"),
        }),
      ),
      model((m) => expect(m.lookup._tag).toBe("Failed")),
    );
  });

  it("ignores results for a lookup that was replaced", () => {
    const active = update(
      update(withIndexes, Message.UpdatedLookupKey({ value: "b" })).model,
      Message.SubmittedLookup(),
    ).model;
    story(
      update,
      given(active),
      message(
        Message.SucceededLookup({ index: "email", key: "a", version: 2, page: found(["late"]) }),
      ),
      model((m) => expect(m.lookup).toEqual(active.lookup)),
    );
  });
});
