import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { Command, given, message, model, story } from "foldkit/story";
import { ada, apiFailure, personType } from "@/domain/entityStore.fixture";
import {
  CreateEntity,
  Entities,
  FetchEntities,
  FetchMoreEntities,
  FetchType,
  init,
  Message,
  More,
  update,
} from "./main.ts";

const initial = init("person");
const loaded = update(initial.model, Message.SucceededFetchType({ info: personType })).model;

const page = (ids: ReadonlyArray<string>, nextCursor: Option.Option<string>) => ({
  items: ids.map((id) => ada({ id })),
  failures: [],
  nextCursor,
});

describe("type detail", () => {
  it("fetches the type, then its entities at the latest version", () => {
    expect(initial.commands?.map((c) => c.name)).toEqual([FetchType.name]);
    story(
      update,
      given(initial.model),
      message(Message.SucceededFetchType({ info: personType })),
      model((m) => {
        expect(m.readVersion).toEqual(Option.some(2));
        expect(m.writeVersion).toEqual(Option.some(2));
        expect(JSON.parse(m.dataText)).toEqual({ fullName: "" });
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

  it("swaps the data template when the write version changes, unless it was edited", () => {
    story(
      update,
      given(loaded),
      message(Message.SelectedWriteVersion({ version: 1 })),
      model((m) => expect(JSON.parse(m.dataText)).toEqual({ firstName: "", lastName: "" })),
      message(Message.UpdatedEntityData({ value: '{"firstName":"Ada"}' })),
      message(Message.SelectedWriteVersion({ version: 2 })),
      model((m) => {
        expect(m.dataText).toBe('{"firstName":"Ada"}');
        expect(m.writeVersion).toEqual(Option.some(2));
      }),
    );
  });

  it("creates an entity in the chosen version, then refreshes the list", () => {
    story(
      update,
      given(loaded),
      message(Message.SelectedWriteVersion({ version: 1 })),
      message(Message.UpdatedEntityId({ value: " ada " })),
      message(Message.UpdatedEntityData({ value: '{"firstName":"Ada","lastName":"L"}' })),
      message(Message.SubmittedNewEntity()),
      Command.expectHas(
        CreateEntity({
          name: "person",
          version: 1,
          id: Option.some("ada"),
          data: { firstName: "Ada", lastName: "L" },
        }),
      ),
      Command.resolve(CreateEntity, Message.SucceededCreateEntity({ entity: ada() })),
      model((m) => {
        expect(m.creation).toEqual({ _tag: "Created", id: "ada" });
        expect(m.idText).toBe("");
      }),
      Command.resolve(
        FetchEntities,
        Message.SucceededFetchEntities({ version: 2, page: page(["ada"], Option.none()) }),
      ),
    );
  });

  it("reports malformed JSON and API validation failures", () => {
    story(
      update,
      given(loaded),
      message(Message.UpdatedEntityData({ value: "{" })),
      message(Message.SubmittedNewEntity()),
      Command.expectNone(),
      model((m) => expect(m.creation._tag).toBe("Invalid")),
      message(Message.UpdatedEntityData({ value: "{}" })),
      message(Message.SubmittedNewEntity()),
      Command.resolve(
        CreateEntity,
        Message.FailedCreateEntity({
          failure: apiFailure(422, "ValidationFailed", "Data doesn't match person v2"),
        }),
      ),
      model((m) => expect(m.creation._tag).toBe("Failed")),
    );
  });
});
