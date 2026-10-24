import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { Command, given, message, model, story } from "foldkit/story";
import {
  apiFailure,
  failingReport,
  passingReport,
  personType,
  personV2Schema,
} from "@/domain/entityStore.fixture";
import { prettyJson } from "@/domain/json";
import { Dialog } from "@foldkit/ui";
import {
  Check,
  CheckLens,
  CreateVersion,
  FetchUsage,
  FetchFunctions,
  FetchType,
  init,
  Message,
  NavigateToType,
  RunLens,
  Submission,
  Trial,
  update,
} from "./main.ts";

const initial = init("person");
const loaded = update(initial.model, Message.SucceededFetchType({ info: personType })).model;
const lens = { ops: [{ op: "add", field: "age" }] };
const drafted = update(loaded, Message.UpdatedLensText({ value: JSON.stringify(lens) })).model;

describe("new version", () => {
  it("prefills the schema editor with the latest schema and a sample document", () => {
    expect(initial.commands?.map((c) => c.name)).toEqual([FetchType.name, FetchFunctions.name]);
    expect(loaded.schemaText).toBe(prettyJson(personV2Schema));
    expect(JSON.parse(loaded.trialDoc)).toEqual({ fullName: "" });
  });

  it("does not clobber a schema the user already typed", () => {
    story(
      update,
      given(initial.model),
      message(Message.UpdatedSchemaText({ value: '{"fields":{}}' })),
      message(Message.SucceededFetchType({ info: personType })),
      model((m) => expect(m.schemaText).toBe('{"fields":{}}')),
    );
  });

  it("checks the lens and shows the report", () => {
    story(
      update,
      given(drafted),
      message(Message.ClickedCheckLens()),
      Command.expectExact(
        CheckLens({ name: "person", schema: personV2Schema, lens, expectedVersion: 2 }),
      ),
      Command.resolve(
        CheckLens,
        Message.SucceededCheckLens({ from: 2, to: 3, report: passingReport }),
      ),
      model((m) =>
        expect(m.check).toEqual(Check.Checked({ from: 2, to: 3, report: passingReport })),
      ),
      message(Message.UpdatedLensText({ value: "{}" })),
      model((m) => expect(m.check).toEqual(Check.Idle())),
    );
  });

  it("names the editor that isn't valid JSON", () => {
    story(
      update,
      given(update(drafted, Message.UpdatedLensText({ value: "{ops: []}" })).model),
      message(Message.ClickedCheckLens()),
      Command.expectNone(),
      model((m) => {
        expect(m.check._tag === "Invalid" && m.check.message).toMatch(/^Lens isn't valid JSON/);
      }),
    );
  });

  it("confirms a version against the version it was written from, offers to force a rejected lens, then navigates", () => {
    story(
      update,
      given(update(drafted, Message.UpdatedNote({ value: " add age " })).model),
      message(Message.SubmittedNewVersion()),
      model((m) => {
        expect(m.dialog.isOpen).toBe(true);
        expect(Option.map(m.maybePending, (pending) => pending.proposal.title)).toEqual(
          Option.some("Save person v3"),
        );
      }),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      Command.resolve(FetchUsage, Message.FailedFetchUsage({ failure: apiFailure(0, "x", "off") })),
      message(Message.ClickedConfirm()),
      Command.expectExact(
        CreateVersion({
          name: "person",
          schema: personV2Schema,
          lens,
          note: "add age",
          force: false,
          expectedVersion: 2,
        }),
      ),
      Command.resolve(
        CreateVersion,
        Message.FailedCreateVersion({
          failure: apiFailure(422, "LensCheckFailed", "The lens produced invalid documents", {
            report: Option.some(failingReport),
          }),
        }),
      ),
      model((m) => {
        expect(m.submission).toEqual(Submission.Rejected({ report: failingReport }));
        expect(m.dialog.isOpen).toBe(false);
      }),
      Command.resolve(Dialog.CloseDialog, Dialog.Message.CompletedCloseDialog()),
      message(Message.ClickedCreateAnyway()),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      Command.resolve(FetchUsage, Message.FailedFetchUsage({ failure: apiFailure(0, "x", "off") })),
      message(Message.ClickedConfirm()),
      Command.expectExact(
        CreateVersion({
          name: "person",
          schema: personV2Schema,
          lens,
          note: "add age",
          force: true,
          expectedVersion: 2,
        }),
      ),
      Command.resolve(CreateVersion, Message.SucceededCreateVersion()),
      Command.resolve(Dialog.CloseDialog, Dialog.Message.CompletedCloseDialog()),
      Command.resolve(NavigateToType, Message.CompletedNavigateToType()),
    );
  });

  it("drops a rejection once the draft changes, so 'Create anyway' can't force an unchecked lens", () => {
    story(
      update,
      given(
        update(
          drafted,
          Message.FailedCreateVersion({
            failure: apiFailure(422, "LensCheckFailed", "x", {
              report: Option.some(failingReport),
            }),
          }),
        ).model,
      ),
      message(Message.UpdatedLensText({ value: '{"ops":[]}' })),
      model((m) => expect(m.submission).toEqual(Submission.Idle())),
    );
  });

  it("keeps a stale version's conflict in the dialog", () => {
    story(
      update,
      given(drafted),
      message(Message.SubmittedNewVersion()),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      Command.resolve(FetchUsage, Message.FailedFetchUsage({ failure: apiFailure(0, "x", "off") })),
      message(Message.ClickedConfirm()),
      Command.resolve(
        CreateVersion,
        Message.FailedCreateVersion({
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
      model((m) => {
        expect(m.confirmation._tag).toBe("Failed");
        expect(m.dialog.isOpen).toBe(true);
      }),
    );
  });

  it("runs the lens on a sample document in the chosen direction", () => {
    story(
      update,
      given(drafted),
      message(Message.SelectedTrialDirection({ direction: "backward" })),
      message(Message.UpdatedTrialDoc({ value: '{"fullName":"A B","age":3}' })),
      message(Message.ClickedRunLens()),
      Command.expectExact(
        RunLens({ lens, direction: "backward", doc: { fullName: "A B", age: 3 } }),
      ),
      Command.resolve(RunLens, Message.SucceededRunLens({ output: { fullName: "A B" } })),
      model((m) => expect(m.trial).toEqual(Trial.Succeeded({ output: { fullName: "A B" } }))),
    );
  });
});
