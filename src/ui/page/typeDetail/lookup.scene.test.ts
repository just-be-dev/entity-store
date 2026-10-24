import { describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import {
  Command,
  click,
  expect,
  given,
  label,
  role,
  scene,
  submit,
  text,
  type,
  within,
} from "foldkit/scene";
import * as EntityForm from "@/components/entityForm/main";
import { ada, apiFailure, emailIndex, personType } from "@/domain/entityStore.fixture";
import { init, LookUpEntities, Message, update, view } from "./index.ts";

const withIndexes = (items: Parameters<typeof Message.SucceededFetchIndexes>[0]["items"]) =>
  [
    Message.SucceededFetchType({ info: personType }),
    Message.SucceededFetchEntities({
      version: 2,
      page: {
        items: [ada(), ada({ id: "grace", data: { fullName: "Grace Hopper" } })],
        failures: [],
        nextCursor: Option.none(),
      },
    }),
    Message.SucceededFetchIndexes({ items }),
  ].reduce((m, msg) => update(m, msg).model, init("person").model);

describe("type detail lookup", () => {
  it("hides the lookup until the type has a ready index, and links to index management", () => {
    scene(
      { update, view },
      given(withIndexes([emailIndex({ state: "building" })])),
      expect(role("search", { name: "Find by index" })).not.toExist(),
      expect(text("building")).toExist(),
      expect(role("link", { name: "Manage indexes" })).toHaveAttr("href", "/types/person/indexes"),
    );
  });

  it("finds entities by key and goes back to the full list", () => {
    scene(
      { update, view },
      given(withIndexes([emailIndex()])),
      expect(text("lower(email)")).toExist(),
      expect(role("button", { name: "Find" })).toBeDisabled(),
      type(label("Key"), "ada@example.com"),
      click(role("button", { name: "Find" })),
      Command.resolve(
        LookUpEntities,
        Message.SucceededLookup({
          index: "email",
          key: "ada@example.com",
          version: 2,
          page: { items: [ada()], failures: [], nextCursor: Option.none() },
        }),
      ),
      expect(role("link", { name: "ada" })).toExist(),
      expect(role("link", { name: "grace" })).not.toExist(),
      click(role("button", { name: "Show all" })),
      expect(role("link", { name: "grace" })).toExist(),
    );
  });

  it("says when nothing has the key", () => {
    scene(
      { update, view },
      given(withIndexes([emailIndex()])),
      type(label("Key"), "Ada@Example.com"),
      click(role("button", { name: "Find" })),
      Command.resolve(
        LookUpEntities,
        Message.SucceededLookup({
          index: "email",
          key: "Ada@Example.com",
          version: 2,
          page: { items: [], failures: [], nextCursor: Option.none() },
        }),
      ),
      expect(text("No matches")).toExist(),
      expect(text('No entity has email = "Ada@Example.com". Keys match exactly.')).toExist(),
    );
  });

  it("names who holds a unique key when the dry run refuses a new entity", () => {
    scene(
      { update, view },
      given(withIndexes([emailIndex()])),
      type(label("ID"), "ada2"),
      type(label("fullName"), "Ada"),
      submit(role("form", { name: "New person" })),
      Command.resolve(
        EntityForm.CheckWrite,
        EntityForm.Message.FailedCheckWrite({
          failure: apiFailure(409, "UniqueViolation", "email: 'ada@example.com' is taken by ada", {
            conflicts: [{ index: "email", key: "ada@example.com", id: Option.some("ada") }],
          }),
        }),
      ),
      expect(role("list", { name: "Taken keys" })).toContainText("is taken by"),
      expect(
        within(role("list", { name: "Taken keys" }), role("link", { name: "ada" })),
      ).toHaveAttr("href", "/entities/ada"),
    );
  });
});
