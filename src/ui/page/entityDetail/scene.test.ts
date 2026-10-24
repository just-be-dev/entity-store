import { describe, it } from "@effect/vitest";
import { Dialog } from "@foldkit/ui";
import * as Option from "effect/Option";
import {
  Command,
  Mount,
  change,
  click,
  expect,
  given,
  inside,
  label,
  role,
  scene,
  submit,
  text,
  type,
} from "foldkit/scene";
import * as EntityForm from "@/components/entityForm/main";
import { ada, apiFailure, personType, revision } from "@/domain/entityStore.fixture";
import {
  FetchBacklinks,
  FetchEditBase,
  FetchUsage,
  Message,
  WriteEntity,
  init,
  update,
  view,
} from "./main.ts";

const openedDialog = [Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()] as const;
const acquired = Dialog.Message.SucceededAcquireResources();

const loaded = [
  Message.SucceededFetchEntity({ requested: Option.none(), entity: ada(), included: {} }),
  Message.SucceededFetchType({ info: personType }),
  Message.SucceededFetchHistory({
    requested: Option.none(),
    page: {
      id: "ada",
      type: "person",
      items: [revision(3, "patch"), revision(1, "create")],
      failures: [{ rev: 2, error: "Lens failed near v2" }],
      nextBefore: Option.none(),
    },
  }),
  Message.SucceededFetchBacklinks({ page: { items: [], nextCursor: Option.none() } }),
].reduce((m, msg) => update(m, msg).model, init("ada").model);

describe("entity detail", () => {
  it("shows the entity's facts, data, and history", () => {
    scene(
      { update, view },
      given(loaded),
      expect(role("heading", { name: "ada" })).toExist(),
      expect(role("link", { name: "person" })).toHaveAttr("href", "/types/person"),
      expect(text("Stored as")).toExist(),
      expect(label("Show as")).toHaveValue("2"),
      expect(text("rev 3")).toExist(),
      expect(text("written as v1 · stored v1")).toExist(),
      expect(text("rev 2 can't be shown at this version: Lens failed near v2")).toExist(),
    );
  });

  it("edits through typed inputs, checking each value, and explains a conflict", () => {
    scene(
      { update, view },
      given(loaded),
      expect(label("fullName")).toHaveValue("Ada Lovelace"),
      expect(label("age")).toHaveAttr("type", "number"),
      type(label("age"), "1.5"),
      submit(role("form", { name: "Edit person" })),
      expect(text("One field can't be saved.")).toExist(),
      expect(text(/Expected an integer/)).toExist(),
      type(label("age"), "36"),
      type(label("fullName"), "Augusta King"),
      submit(role("form", { name: "Edit person" })),
      Command.expectExact(
        EntityForm.CheckWrite({
          type: "person",
          id: "ada",
          version: 2,
          patch: { fullName: "Augusta King", age: 36 },
        }),
      ),
      Command.resolve(
        EntityForm.CheckWrite,
        EntityForm.Message.SucceededCheckWrite({
          check: { data: { fullName: "Augusta King", age: 36 }, version: 2, created: false },
        }),
      ),
      Command.resolveAll(openedDialog),
      Mount.resolve(Dialog.AcquireResources, acquired),
      Command.resolve(
        FetchUsage,
        Message.SucceededFetchUsage({
          consumers: {
            type: "person",
            automations: { status: "unavailable", reason: "automations didn't answer" },
          },
        }),
      ),
      expect(role("dialog", { name: "Save person ada" })).toExist(),
      expect(role("region", { name: "Consequences" })).toContainText(
        "Couldn't check automations: automations didn't answer",
      ),
      click(role("button", { name: "Save" })),
      expect(role("button", { name: "Working…" })).toBeDisabled(),
      Command.resolve(
        WriteEntity,
        Message.FailedWrite({
          failure: apiFailure(409, "RevConflict", "Entity 'ada' is at rev 5, not 3", {
            currentRev: Option.some(5),
          }),
        }),
      ),
      expect(role("dialog")).toContainText("Entity 'ada' is at rev 5, not 3"),
      expect(text(/Someone else edited this entity \(now at rev 5\)/)).toExist(),
    );
  });

  it("edits the raw JSON as an escape hatch", () => {
    scene(
      { update, view },
      given(loaded),
      click(role("button", { name: "Edit as JSON" })),
      expect(label("Data as v2 (JSON)")).toHaveValue('{\n  "fullName": "Ada Lovelace"\n}'),
      type(label("Data as v2 (JSON)"), '{"fullName":"Ada", "extra": 1}'),
      submit(role("form", { name: "Edit person" })),
      expect(role("alert")).toContainText("doesn't match v2"),
      click(role("button", { name: "Edit fields" })),
      expect(label("fullName")).toHaveValue("Ada"),
    );
  });

  it("asks for confirmation before deleting, showing what goes", () => {
    scene(
      { update, view },
      given(loaded),
      click(role("button", { name: "Delete entity" })),
      Command.resolveAll(openedDialog),
      Mount.resolve(Dialog.AcquireResources, acquired),
      Command.resolve(
        FetchUsage,
        Message.FailedFetchUsage({ failure: apiFailure(0, "x", "Couldn't reach the API") }),
      ),
      expect(text("Checking who links to it…")).toExist(),
      Command.resolve(
        FetchBacklinks,
        Message.SucceededFetchBacklinks({ page: { items: [], nextCursor: Option.none() } }),
      ),
      expect(role("dialog", { name: "Delete person ada" })).toExist(),
      expect(role("table", { name: "Changes" })).toContainText("Ada Lovelace"),
      expect(role("table", { name: "Changes" })).toContainText("Removed"),
      expect(role("button", { name: "Delete" })).toBeEnabled(),
      inside(role("dialog"), click(role("button", { name: "Cancel" }))),
      Command.resolveAll([Dialog.CloseDialog, Dialog.Message.CompletedCloseDialog()]),
      Mount.expectEnded(Dialog.AcquireResources),
      expect(role("dialog", { name: "Delete person ada" })).not.toExist(),
    );
  });

  it("changes the write version, re-forming the inputs", () => {
    scene(
      { update, view },
      given(loaded),
      change(label("Write as"), "1"),
      expect(text("Loading the entity as v1…")).toExist(),
      Command.resolve(
        FetchEditBase,
        Message.SucceededFetchEditBase({
          entity: ada({ version: 1, data: { firstName: "Ada", lastName: "Lovelace" } }),
        }),
      ),
      expect(label("firstName")).toHaveValue("Ada"),
      expect(label("nickname")).toHaveValue(""),
    );
  });

  it("shows a deleted entity's error", () => {
    scene(
      { update, view },
      given(
        update(
          init("ada").model,
          Message.FailedFetchEntity({
            requested: Option.none(),
            failure: apiFailure(410, "EntityDeleted", "Entity 'ada' was deleted at rev 4"),
          }),
        ).model,
      ),
      expect(role("alert")).toContainText("Entity 'ada' was deleted at rev 4"),
      expect(role("form", { name: "Edit person" })).toBeAbsent(),
    );
  });
});
