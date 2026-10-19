import { describe, it } from "@effect/vitest";
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
} from "foldkit/scene";
import { apiFailure } from "@/domain/entityStore.fixture";
import { CheckSchema, CreateType, init, Message, Model, Types, update, view } from "./main.ts";

const loaded = Model.make({
  ...init().model,
  types: Types.Loaded({
    items: [
      { name: "person", description: "People", latestVersion: 2, createdAt: 0, updatedAt: 0 },
      { name: "task", description: "", latestVersion: 1, createdAt: 0, updatedAt: 0 },
    ],
  }),
});

describe("type list", () => {
  it("lists types with links to their pages", () => {
    scene(
      { update, view },
      given(loaded),
      expect(role("heading", { name: "Entity types" })).toExist(),
      expect(role("link", { name: "person" })).toHaveAttr("href", "/types/person"),
      expect(text("v2")).toExist(),
      expect(role("link", { name: "task" })).toExist(),
    );
  });

  it("shows an empty state and a loading failure", () => {
    scene(
      { update, view },
      given(Model.make({ ...loaded, types: Types.Loaded({ items: [] }) })),
      expect(text("No entity types yet")).toExist(),
    );
    scene(
      { update, view },
      given(
        Model.make({
          ...loaded,
          types: Types.Failed({ failure: apiFailure(500, "StorageFailure", "Storage error") }),
        }),
      ),
      expect(role("alert")).toContainText("Storage error"),
    );
  });

  it("submits the form and shows the API's issues when the schema is rejected", () => {
    scene(
      { update, view },
      given(loaded),
      type(label("Name"), "widget"),
      type(label("Schema (JSON)"), '{"fields":{"x":{"type":"wat"}}}'),
      submit(role("form", { name: "New type" })),
      expect(role("button", { name: "Creating…" })).toBeDisabled(),
      Command.resolve(
        CreateType,
        Message.FailedCreateType({
          failure: apiFailure(400, "BadRequest", "Expected a known field type", {
            issues: [{ path: "fields.x", message: "Unknown type 'wat'" }],
          }),
        }),
      ),
      expect(role("alert")).toContainText("Expected a known field type"),
      expect(text("fields.x")).toExist(),
      expect(label("Name")).toHaveValue("widget"),
    );
  });

  it("checks the schema on demand", () => {
    scene(
      { update, view },
      given(loaded),
      click(role("button", { name: "Check schema" })),
      Command.resolve(
        CheckSchema,
        Message.SucceededCheckSchema({
          ok: false,
          issues: [{ path: "fields.a b", message: "Field names must be identifiers" }],
        }),
      ),
      expect(role("alert")).toContainText("Field names must be identifiers"),
    );
  });
});
