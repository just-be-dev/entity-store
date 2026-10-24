import { describe, it } from "@effect/vitest";
import {
  Command,
  Mount,
  change,
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
import { Dialog } from "@foldkit/ui";
import { apiFailure } from "@/domain/entityStore.fixture";
import { CreateType, Message, Model, NavigateToType, Types, init, update, view } from "./main.ts";

const loaded = update(
  init().model,
  Message.SucceededFetchTypes({
    items: [
      { name: "person", description: "People", latestVersion: 2, createdAt: 0, updatedAt: 0 },
      { name: "task", description: "", latestVersion: 1, createdAt: 0, updatedAt: 0 },
    ],
  }),
).model;

const openedDialog = [Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()] as const;
const closedDialog = [Dialog.CloseDialog, Dialog.Message.CompletedCloseDialog()] as const;
const acquired = Dialog.Message.SucceededAcquireResources();

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

  it("builds a type from field rows, confirms it, creates it, and goes to it", () => {
    scene(
      { update, view },
      given(loaded),
      type(label("Name"), "hire"),
      click(role("button", { name: "Add field" })),
      type(label("Name of new field"), "manager"),
      change(label("Kind of manager"), "link"),
      change(label("Points to (manager)"), "person"),
      click(role("button", { name: "Add field" })),
      type(label("Name of new field"), "starts"),
      change(label("Kind of starts"), "date"),
      click(role("checkbox", { name: "starts is required" })),
      expect(label("Title field")).toHaveValue("0"),
      submit(role("form", { name: "New type" })),
      Command.resolveAll(openedDialog),
      Mount.resolve(Dialog.AcquireResources, acquired),
      expect(role("dialog", { name: "Create hire" })).toExist(),
      expect(role("table", { name: "Changes" })).toContainText("Link to person, optional"),
      expect(role("table", { name: "Changes" })).toContainText("Text, required, title"),
      expect(role("table", { name: "Changes" })).toContainText("Date, required"),
      expect(role("region", { name: "Consequences" })).toContainText("Creates hire at v1"),
      click(role("button", { name: "Create type" })),
      Command.expectExact(
        CreateType({
          name: "hire",
          description: "",
          schema: {
            title: "name",
            fields: {
              name: { type: "string" },
              manager: { type: "link", to: "person", optional: true },
              starts: { type: "string", format: "date" },
            },
          },
        }),
      ),
      expect(role("button", { name: "Working…" })).toBeDisabled(),
      Command.resolve(CreateType, Message.SucceededCreateType({ name: "hire" })),
      Command.resolveAll(closedDialog),
      Mount.expectEnded(Dialog.AcquireResources),
      Command.resolve(NavigateToType, Message.CompletedNavigateToType()),
    );
  });

  it("names what to fix in the rows before anything is sent", () => {
    scene(
      { update, view },
      given(loaded),
      type(label("Name"), "hire"),
      click(role("button", { name: "Add field" })),
      type(label("Name of new field"), "boss"),
      change(label("Kind of boss"), "link"),
      submit(role("form", { name: "New type" })),
      Command.expectNone(),
      expect(role("alert")).toContainText("Choose the type boss points to"),
    );
  });

  it("refuses a name that's taken", () => {
    scene(
      { update, view },
      given(loaded),
      type(label("Name"), "person"),
      submit(role("form", { name: "New type" })),
      expect(role("alert")).toContainText("There's already a type named person"),
    );
  });

  it("keeps raw JSON for advanced schemas and shows the API's refusal in the dialog", () => {
    scene(
      { update, view },
      given(loaded),
      type(label("Name"), "widget"),
      click(role("button", { name: "Edit as JSON" })),
      expect(label("Schema (JSON)")).toHaveValue(
        JSON.stringify({ title: "name", fields: { name: { type: "string" } } }, null, 2),
      ),
      type(
        label("Schema (JSON)"),
        '{"fields":{"tags":{"type":"array","items":{"type":"string"}}}}',
      ),
      submit(role("form", { name: "New type" })),
      Command.resolveAll(openedDialog),
      Mount.resolve(Dialog.AcquireResources, acquired),
      click(role("button", { name: "Create type" })),
      Command.resolve(
        CreateType,
        Message.FailedCreateType({
          failure: apiFailure(422, "InvalidSchema", "The schema definition is invalid", {
            issues: [{ path: "fields.tags", message: "Too many" }],
          }),
        }),
      ),
      expect(role("dialog")).toContainText("The schema definition is invalid"),
      expect(role("button", { name: "Create type" })).toBeEnabled(),
    );
  });
});
