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
  within,
} from "foldkit/scene";
import * as EntityForm from "@/components/entityForm/main";
import type { AutomationsUsage, TypeConsumers } from "@/domain/entityStore";
import { ada, apiFailure, passingReport, personType } from "@/domain/entityStore.fixture";
import {
  AddVersion,
  CheckDelete,
  CheckVersion,
  DeleteEntity,
  DeleteType,
  FetchBacklinks,
  FetchEntities,
  FetchMoreEntities,
  FetchType,
  FetchTypeNames,
  FetchUsage,
  Message,
  NavigateToTypes,
  WriteEntity,
  init,
  update,
  view,
} from "./index.ts";

const openedDialog = [Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()] as const;
const closedDialog = [Dialog.CloseDialog, Dialog.Message.CompletedCloseDialog()] as const;
const acquired = Dialog.Message.SucceededAcquireResources();

const loaded = update(init("person").model, Message.SucceededFetchType({ info: personType })).model;

const withEntities = update(
  loaded,
  Message.SucceededFetchEntities({
    version: 2,
    page: {
      items: [ada({ data: { fullName: "Ada Lovelace", age: 36 } })],
      failures: [{ id: "broken", rev: 2, storedVersion: 1, error: "Lens failed near v2" }],
      nextCursor: Option.some("ada"),
    },
  }),
).model;

const unavailable: AutomationsUsage = {
  status: "unavailable",
  reason: "automations isn't connected to this stage",
};

const watched: AutomationsUsage = {
  status: "checked",
  watching: [
    {
      id: "onboarding",
      name: "Onboarding",
      trigger: {
        kind: "entity",
        event: Option.none(),
        fields: Option.some(["fullName"]),
        hasCondition: false,
      },
    },
  ],
  listening: [
    {
      id: "audit",
      name: "Audit",
      trigger: {
        kind: "event",
        event: Option.some("entity.deleted"),
        fields: Option.none(),
        hasCondition: true,
      },
    },
  ],
  templateSlots: [],
  unchecked: [],
};

const consumers = (automations: AutomationsUsage): TypeConsumers => ({
  type: "person",
  automations,
});

describe("type detail", () => {
  it("shows every field as a column, projection failures, and versions", () => {
    scene(
      { update, view },
      given(withEntities),
      expect(role("heading", { name: "person" })).toExist(),
      expect(role("link", { name: "ada" })).toHaveAttr("href", "/entities/ada"),
      expect(role("columnheader", { name: "fullName" })).toExist(),
      expect(role("columnheader", { name: "age" })).toExist(),
      expect(within(role("table", { name: "Entities" }), text("Ada Lovelace"))).toExist(),
      expect(within(role("table", { name: "Entities" }), text("36"))).toExist(),
      expect(text("1 entity couldn't be shown at this version")).toExist(),
      expect(role("link", { name: "New version" })).toHaveAttr(
        "href",
        "/types/person/versions/new",
      ),
      expect(text("Merge names")).toExist(),
    );
  });

  it("re-reads the list, with that version's columns, when another read version is chosen", () => {
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
      expect(role("columnheader", { name: "firstName" })).toExist(),
      expect(within(role("table", { name: "Entities" }), text("Lovelace"))).toExist(),
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

  it("edits a row in place, confirms the field-by-field change, and saves it", () => {
    scene(
      { update, view },
      given(withEntities),
      click(role("button", { name: "Edit ada" })),
      expect(role("region", { name: "Editing ada" })).toExist(),
      expect(label("fullName")).toHaveValue("Ada Lovelace"),
      type(label("fullName"), "Augusta Ada King"),
      type(label("age"), ""),
      submit(role("form", { name: "Edit person" })),
      Command.expectExact(
        EntityForm.CheckWrite({
          type: "person",
          id: "ada",
          version: 2,
          patch: { fullName: "Augusta Ada King", age: null },
        }),
      ),
      Command.resolve(
        EntityForm.CheckWrite,
        EntityForm.Message.SucceededCheckWrite({
          check: { data: { fullName: "Augusta Ada King" }, version: 2, created: false },
        }),
      ),
      Command.resolveAll(openedDialog),
      Mount.resolve(Dialog.AcquireResources, acquired),
      expect(role("dialog", { name: "Save person ada" })).toExist(),
      expect(text("Checking automations…")).toExist(),
      Command.resolve(
        FetchUsage,
        Message.SucceededFetchUsage({ consumers: consumers(unavailable) }),
      ),
      expect(role("table", { name: "Changes" })).toContainText("Augusta Ada King"),
      expect(role("table", { name: "Changes" })).toContainText("Removed"),
      expect(role("region", { name: "Consequences" })).toContainText(
        "Couldn't check automations: automations isn't connected to this stage",
      ),
      expect(role("region", { name: "Consequences" })).toContainText("entity.updated"),
      click(role("button", { name: "Save" })),
      Command.expectExact(
        WriteEntity({
          write: EntityForm.PreparedWrite.Upsert({
            type: "person",
            id: "ada",
            version: 2,
            patch: { fullName: "Augusta Ada King", age: null },
            expectedRev: 3,
            before: { fullName: "Ada Lovelace", age: 36 },
            after: { fullName: "Augusta Ada King" },
            created: false,
          }),
        }),
      ),
      Command.resolve(
        WriteEntity,
        Message.SucceededSaveEntity({
          entity: ada({ rev: 4, data: { fullName: "Augusta Ada King" } }),
        }),
      ),
      Command.resolveAll(closedDialog),
      Mount.expectEnded(Dialog.AcquireResources),
      Command.resolve(
        FetchEntities,
        Message.SucceededFetchEntities({
          version: 2,
          page: {
            items: [ada({ rev: 4, data: { fullName: "Augusta Ada King" } })],
            failures: [],
            nextCursor: Option.none(),
          },
        }),
      ),
      expect(role("status")).toContainText("Saved ada at rev 4."),
      expect(role("region", { name: "Editing ada" })).not.toExist(),
    );
  });

  it("keeps the dialog open and says so when someone else saved first", () => {
    scene(
      { update, view },
      given(withEntities),
      click(role("button", { name: "Edit ada" })),
      type(label("age"), "37"),
      submit(role("form", { name: "Edit person" })),
      Command.resolve(
        EntityForm.CheckWrite,
        EntityForm.Message.SucceededCheckWrite({
          check: { data: { fullName: "Ada Lovelace", age: 37 }, version: 2, created: false },
        }),
      ),
      Command.resolveAll(openedDialog),
      Mount.resolve(Dialog.AcquireResources, acquired),
      Command.resolve(FetchUsage, Message.SucceededFetchUsage({ consumers: consumers(watched) })),
      expect(role("region", { name: "Consequences" })).toContainText(
        "Onboarding (onboarding) watches fullName, which this doesn't change",
      ),
      click(role("button", { name: "Save" })),
      Command.resolve(
        WriteEntity,
        Message.FailedWrite({
          failure: apiFailure(409, "RevConflict", "Entity 'ada' is at rev 5, not 3", {
            currentRev: Option.some(5),
          }),
        }),
      ),
      expect(role("dialog")).toContainText("Entity 'ada' is at rev 5, not 3"),
    );
  });

  it("refuses deleting a row other entities link to", () => {
    scene(
      { update, view },
      given(withEntities),
      click(role("button", { name: "Delete ada" })),
      Command.resolveAll(openedDialog),
      Mount.resolve(Dialog.AcquireResources, acquired),
      expect(text("Checking who links to it…")).toExist(),
      Command.resolve(FetchUsage, Message.SucceededFetchUsage({ consumers: consumers(watched) })),
      Command.resolve(
        FetchBacklinks,
        Message.SucceededFetchBacklinks({
          id: "ada",
          page: {
            items: [{ source: "p1", type: "post", path: "author" }],
            nextCursor: Option.none(),
          },
        }),
      ),
      expect(role("dialog")).toContainText("Other entities link to it: p1 (post, author)"),
      expect(role("button", { name: "Delete" })).toBeDisabled(),
    );
  });

  it("deletes a row after showing what it removes and which automations notice", () => {
    scene(
      { update, view },
      given(withEntities),
      click(role("button", { name: "Delete ada" })),
      Command.resolveAll(openedDialog),
      Mount.resolve(Dialog.AcquireResources, acquired),
      Command.resolve(FetchUsage, Message.SucceededFetchUsage({ consumers: consumers(watched) })),
      Command.resolve(
        FetchBacklinks,
        Message.SucceededFetchBacklinks({
          id: "ada",
          page: { items: [], nextCursor: Option.none() },
        }),
      ),
      expect(role("table", { name: "Changes" })).toContainText("Ada Lovelace"),
      expect(role("region", { name: "Consequences" })).toContainText(
        "Onboarding (onboarding) watches person, but deletes don't start it",
      ),
      expect(role("region", { name: "Consequences" })).toContainText(
        "Audit (audit) starts on entity.deleted, if its condition holds",
      ),
      click(role("button", { name: "Delete" })),
      Command.expectExact(DeleteEntity({ id: "ada", expectedRev: 3 })),
      Command.resolve(DeleteEntity, Message.SucceededDeleteEntity({ id: "ada", rev: 4 })),
      Command.resolveAll(closedDialog),
      Mount.expectEnded(Dialog.AcquireResources),
      Command.resolve(
        FetchEntities,
        Message.SucceededFetchEntities({
          version: 2,
          page: { items: [], failures: [], nextCursor: Option.none() },
        }),
      ),
      expect(role("status")).toContainText("Deleted ada at rev 4."),
    );
  });

  it("creates an entity from typed inputs, checking the ID and each value first", () => {
    scene(
      { update, view },
      given(withEntities),
      change(label("ID"), "ada"),
      Command.resolve(
        EntityForm.CheckId,
        EntityForm.Message.SucceededCheckId({ id: "ada", entity: ada() }),
      ),
      expect(text("ada is taken by a person. Choose another ID.")).toExist(),
      type(label("ID"), ".."),
      expect(text(/aren't only dots/)).toExist(),
      change(label("ID"), "grace"),
      Command.resolve(
        EntityForm.CheckId,
        EntityForm.Message.FailedCheckId({
          id: "grace",
          failure: apiFailure(404, "EntityNotFound", "No entity with id 'grace'"),
        }),
      ),
      expect(text("grace is free.")).toExist(),
      type(label("age"), "thirty"),
      submit(role("form", { name: "New person" })),
      Command.expectNone(),
      expect(text("Required")).toExist(),
      expect(text("Enter a whole number")).toExist(),
      type(label("fullName"), "Grace Hopper"),
      type(label("age"), "85"),
      submit(role("form", { name: "New person" })),
      Command.resolve(
        EntityForm.CheckWrite,
        EntityForm.Message.SucceededCheckWrite({
          check: { data: { fullName: "Grace Hopper", age: 85 }, version: 2, created: true },
        }),
      ),
      Command.resolveAll(openedDialog),
      Mount.resolve(Dialog.AcquireResources, acquired),
      Command.resolve(FetchUsage, Message.SucceededFetchUsage({ consumers: consumers(watched) })),
      expect(role("dialog", { name: "Create person grace" })).toExist(),
      expect(role("table", { name: "Changes" })).toContainText("Not set"),
      expect(role("region", { name: "Consequences" })).toContainText(
        "Onboarding (onboarding) starts for a new person",
      ),
      click(role("button", { name: "Create" })),
      Command.expectHas(WriteEntity),
      Command.resolve(
        WriteEntity,
        Message.SucceededSaveEntity({ entity: ada({ id: "grace", rev: 1 }) }),
      ),
      Command.resolveAll(closedDialog),
      Mount.expectEnded(Dialog.AcquireResources),
      Command.resolve(
        FetchEntities,
        Message.SucceededFetchEntities({
          version: 2,
          page: { items: [], failures: [], nextCursor: Option.none() },
        }),
      ),
      expect(label("ID")).toHaveValue(""),
    );
  });

  it("edits fields in place: a rename and a new field become v3 with a generated lens", () => {
    scene(
      { update, view },
      given(withEntities),
      click(role("button", { name: "Edit fields" })),
      Command.resolve(
        FetchTypeNames,
        Message.SucceededFetchTypeNames({ names: ["person", "team"] }),
      ),
      type(label("Name of fullName"), "name"),
      click(role("button", { name: "Add field" })),
      type(label("Name of new field"), "team"),
      change(label("Kind of team"), "link"),
      change(label("Points to (team)"), "team"),
      submit(role("form", { name: "Edit fields" })),
      Command.expectExact(
        CheckVersion({
          name: "person",
          expectedVersion: 2,
          schema: {
            fields: {
              name: { type: "string" },
              age: { type: "number", integer: true, optional: true },
              team: { type: "link", to: "team", optional: true },
            },
          },
          lens: {
            ops: [
              { op: "rename", from: "fullName", to: "name" },
              { op: "add", field: "team" },
            ],
          },
        }),
      ),
      expect(text("Checking the generated lens…")).toExist(),
      Command.resolve(
        CheckVersion,
        Message.SucceededCheckVersion({ check: { from: 2, to: 3, report: passingReport } }),
      ),
      Command.resolveAll(openedDialog),
      Mount.resolve(Dialog.AcquireResources, acquired),
      Command.resolve(FetchUsage, Message.SucceededFetchUsage({ consumers: consumers(watched) })),
      expect(role("dialog", { name: "Save person v3" })).toExist(),
      expect(role("table", { name: "Changes" })).toContainText("fullName → name"),
      expect(role("table", { name: "Changes" })).toContainText("Link to team, optional"),
      expect(role("region", { name: "Consequences" })).toContainText(
        "Onboarding (onboarding) watches fullName (renamed to name): update its trigger",
      ),
      click(role("button", { name: "Save v3" })),
      Command.expectHas(AddVersion),
      Command.resolve(AddVersion, Message.SucceededAddVersion({ version: 3 })),
      Command.resolveAll(closedDialog),
      Mount.expectEnded(Dialog.AcquireResources),
      Command.resolve(
        FetchType,
        Message.FailedFetchType({ failure: apiFailure(0, "x", "offline") }),
      ),
    );
  });

  it("refuses changing a field's kind in the form, pointing at a hand-written lens", () => {
    scene(
      { update, view },
      given(withEntities),
      click(role("button", { name: "Edit fields" })),
      Command.resolve(FetchTypeNames, Message.SucceededFetchTypeNames({ names: ["person"] })),
      change(label("Kind of age"), "text"),
      submit(role("form", { name: "Edit fields" })),
      Command.expectNone(),
      expect(role("alert")).toContainText(
        "age holds number; changing it to string needs a hand-written lens",
      ),
    );
  });

  it("refuses deleting a type that's in use, and warns when automations can't be checked", () => {
    scene(
      { update, view },
      given(withEntities),
      click(role("button", { name: "Delete type" })),
      Command.expectExact(CheckDelete({ name: "person", expectedVersion: 2 })),
      Command.resolve(
        CheckDelete,
        Message.SucceededCheckDelete({
          check: {
            type: "person",
            latestVersion: 2,
            reasons: ["it has 1 live entity", "automations use it: onboarding (Onboarding)"],
            consumers: consumers(unavailable),
          },
        }),
      ),
      Command.resolveAll(openedDialog),
      Mount.resolve(Dialog.AcquireResources, acquired),
      expect(role("dialog", { name: "Delete person" })).toContainText(
        "person is in use: it has 1 live entity",
      ),
      expect(role("region", { name: "Consequences" })).toContainText("Couldn't check automations"),
      expect(within(role("dialog"), role("button", { name: "Delete type" }))).toBeDisabled(),
    );
  });

  it("deletes an unused type, conditioned on the version it showed", () => {
    scene(
      { update, view },
      given(withEntities),
      click(role("button", { name: "Delete type" })),
      Command.resolve(
        CheckDelete,
        Message.SucceededCheckDelete({
          check: {
            type: "person",
            latestVersion: 2,
            reasons: [],
            consumers: consumers({
              status: "checked",
              watching: [],
              listening: [],
              templateSlots: [],
              unchecked: [],
            }),
          },
        }),
      ),
      Command.resolveAll(openedDialog),
      Mount.resolve(Dialog.AcquireResources, acquired),
      expect(role("region", { name: "Consequences" })).toContainText(
        "No saved automation or template uses person",
      ),
      inside(role("dialog"), click(role("button", { name: "Delete type" }))),
      Command.expectExact(DeleteType({ name: "person", expectedVersion: 2 })),
      Command.resolve(
        DeleteType,
        Message.FailedWrite({
          failure: apiFailure(
            409,
            "VersionConflict",
            "person is at v3, not v2; reload and try again",
            {
              currentVersion: Option.some(3),
            },
          ),
        }),
      ),
      expect(role("dialog")).toContainText("person is at v3, not v2"),
      inside(role("dialog"), click(role("button", { name: "Delete type" }))),
      Command.resolve(DeleteType, Message.SucceededDeleteType({ name: "person" })),
      Command.resolveAll(closedDialog),
      Mount.expectEnded(Dialog.AcquireResources),
      Command.resolve(NavigateToTypes, Message.CompletedNavigateToTypes()),
    );
  });
});
