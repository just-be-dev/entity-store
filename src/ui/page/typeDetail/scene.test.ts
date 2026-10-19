import { describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { Command, change, click, expect, given, label, role, scene, text } from "foldkit/scene";
import { ada, apiFailure, personType } from "@/domain/entityStore.fixture";
import { FetchEntities, FetchMoreEntities, init, Message, update, view } from "./main.ts";

const loaded = update(init("person").model, Message.SucceededFetchType({ info: personType })).model;

const withEntities = update(
  loaded,
  Message.SucceededFetchEntities({
    version: 2,
    page: {
      items: [ada()],
      failures: [{ id: "broken", rev: 2, storedVersion: 1, error: "Lens failed near v2" }],
      nextCursor: Option.some("ada"),
    },
  }),
).model;

describe("type detail", () => {
  it("shows entities, projection failures, versions, and a link to add a version", () => {
    scene(
      { update, view },
      given(withEntities),
      expect(role("heading", { name: "person" })).toExist(),
      expect(role("link", { name: "ada" })).toHaveAttr("href", "/entities/ada"),
      expect(text('{"fullName":"Ada Lovelace"}')).toExist(),
      expect(text("1 entity couldn't be shown at this version")).toExist(),
      expect(role("link", { name: "New version" })).toHaveAttr(
        "href",
        "/types/person/versions/new",
      ),
      expect(text("Merge names")).toExist(),
    );
  });

  it("re-reads the list when another read version is chosen", () => {
    scene(
      { update, view },
      given(withEntities),
      change(label("Read as"), "1"),
      expect(text("Loading entities…")).toExist(),
      Command.resolve(
        FetchEntities,
        Message.SucceededFetchEntities({
          version: 1,
          page: {
            items: [ada({ version: 1, data: { firstName: "Ada", lastName: "Lovelace" } })],
            failures: [],
            nextCursor: Option.none(),
          },
        }),
      ),
      expect(text('{"firstName":"Ada","lastName":"Lovelace"}')).toExist(),
    );
  });

  it("loads more and shows a failure next to the button", () => {
    scene(
      { update, view },
      given(withEntities),
      click(role("button", { name: "Load more" })),
      expect(role("button", { name: "Loading…" })).toBeDisabled(),
      Command.resolve(
        FetchMoreEntities,
        Message.FailedFetchMoreEntities({
          version: 2,
          failure: apiFailure(500, "StorageFailure", "Storage error"),
        }),
      ),
      expect(text("Storage error")).toExist(),
      expect(role("button", { name: "Load more" })).toBeEnabled(),
    );
  });

  it("shows a missing type", () => {
    scene(
      { update, view },
      given(
        update(
          init("ghost").model,
          Message.FailedFetchType({
            failure: apiFailure(404, "TypeNotFound", "No entity type named 'ghost'"),
          }),
        ).model,
      ),
      expect(role("alert")).toContainText("No entity type named 'ghost'"),
    );
  });
});
