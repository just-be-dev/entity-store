import { describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { Dialog } from "@foldkit/ui";
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
  text,
} from "foldkit/scene";
import { apiFailure, failingReport, personType } from "@/domain/entityStore.fixture";
import {
  CheckLens,
  CreateVersion,
  FetchUsage,
  init,
  Message,
  RunLens,
  update,
  view,
} from "./main.ts";

const loaded = [
  Message.SucceededFetchType({ info: personType }),
  Message.SucceededFetchFunctions({
    items: [
      { name: "split", doc: "Split a string by a separator", minArgs: 2, maxArgs: Option.some(2) },
    ],
  }),
].reduce((model, message) => update(model, message).model, init("person").model);

describe("new version", () => {
  it("shows both editors and the reference", () => {
    scene(
      { update, view },
      given(loaded),
      expect(role("heading", { name: "New version" })).toExist(),
      expect(label("Schema v3 (JSON)")).toExist(),
      expect(label("Lens v2 → v3 (JSON)")).toHaveValue('{\n  "ops": []\n}'),
      expect(text("split")).toExist(),
      expect(text("Split a string by a separator")).toExist(),
    );
  });

  it("renders a failing report with its counterexample, loss, and warnings", () => {
    scene(
      { update, view },
      given(loaded),
      click(role("button", { name: "Check lens" })),
      Command.resolve(
        CheckLens,
        Message.SucceededCheckLens({ from: 2, to: 3, report: failingReport }),
      ),
      expect(text("Lens check failed")).toExist(),
      expect(text("1 counterexample of 100")).toExist(),
      expect(text('Missing key at ["tags"]')).toExist(),
      expect(text("2 of 100 lossy")).toExist(),
      expect(text("⚠ 2 of 100 sampled documents don't round-trip")).toExist(),
    );
  });

  it("offers 'Create anyway' after the API rejects the lens", () => {
    scene(
      { update, view },
      given(loaded),
      click(role("button", { name: "Create version" })),
      Command.resolveAll([Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()]),
      Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
      Command.resolve(
        FetchUsage,
        Message.SucceededFetchUsage({
          consumers: {
            type: "person",
            automations: { status: "unavailable", reason: "not connected" },
          },
        }),
      ),
      expect(role("dialog", { name: "Save person v3" })).toExist(),
      expect(role("region", { name: "Consequences" })).toContainText(
        "Couldn't check automations: not connected",
      ),
      inside(role("dialog"), click(role("button", { name: "Create version" }))),
      Command.resolve(
        CreateVersion,
        Message.FailedCreateVersion({
          failure: apiFailure(422, "LensCheckFailed", "The lens produced invalid documents", {
            report: Option.some(failingReport),
          }),
        }),
      ),
      Command.resolveAll([Dialog.CloseDialog, Dialog.Message.CompletedCloseDialog()]),
      Mount.expectEnded(Dialog.AcquireResources),
      expect(role("button", { name: "Create anyway" })).toExist(),
      expect(text("Lens check failed")).toExist(),
    );
  });

  it("tries the lens and shows its error", () => {
    scene(
      { update, view },
      given(loaded),
      change(label("Direction"), "backward"),
      expect(label("New-version document")).toExist(),
      click(role("button", { name: "Run lens" })),
      Command.resolve(
        RunLens,
        Message.FailedRunLens({
          error: "derive firstName: Can't add string and undefined",
          issues: [],
        }),
      ),
      expect(role("alert")).toContainText("Can't add string and undefined"),
    );
  });
});
