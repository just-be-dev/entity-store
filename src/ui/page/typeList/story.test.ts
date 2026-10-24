import { describe, expect, it } from "@effect/vitest";
import { Dialog } from "@foldkit/ui";
import * as Option from "effect/Option";
import { Command, expectOutMessage, given, message, model, story } from "foldkit/story";
import * as TypeForm from "@/components/typeForm/main";
import { Submission } from "@/components/confirm";
import { apiFailure } from "@/domain/entityStore.fixture";
import {
  CreateType,
  FetchTypes,
  init,
  Message,
  NavigateToType,
  OutMessage,
  update,
} from "./main.ts";

const initial = init().model;

const form = (formMessage: TypeForm.Message) =>
  message(Message.GotFormMessage({ message: formMessage }));

const proposeHire = [
  form(TypeForm.Message.UpdatedName({ value: " hire " })),
  form(TypeForm.Message.SubmittedForm()),
] as const;

describe("type list", () => {
  it("init fetches the types, and links can point at them", () => {
    expect(init().commands?.map((command) => command.name)).toEqual([FetchTypes.name]);
    story(
      update,
      given(initial),
      message(
        Message.SucceededFetchTypes({
          items: [
            { name: "person", description: "", latestVersion: 2, createdAt: 0, updatedAt: 0 },
          ],
        }),
      ),
      model((m) => {
        expect(m.types._tag).toBe("Loaded");
        expect(m.form.targets).toEqual(["person"]);
      }),
    );
  });

  it("asks for confirmation before creating, then creates and navigates", () => {
    story(
      update,
      given(initial),
      ...proposeHire,
      model((m) => {
        expect(Option.map(m.maybePending, (pending) => pending.name)).toEqual(Option.some("hire"));
        expect(m.dialog.isOpen).toBe(true);
      }),
      Command.expectHas(Dialog.ShowDialog),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      message(Message.ClickedConfirm()),
      model((m) => expect(m.submission._tag).toBe("Working")),
      Command.expectHas(
        CreateType({
          name: "hire",
          description: "",
          schema: { title: "name", fields: { name: { type: "string" } } },
        }),
      ),
      Command.resolve(CreateType, Message.SucceededCreateType({ name: "hire" })),
      expectOutMessage(OutMessage.CreatedType({ name: "hire" })),
      model((m) => {
        expect(m.dialog.isOpen).toBe(false);
        expect(m.maybePending).toEqual(Option.none());
      }),
      Command.resolve(Dialog.CloseDialog, Dialog.Message.CompletedCloseDialog()),
      Command.resolve(NavigateToType, Message.CompletedNavigateToType()),
    );
  });

  it("ignores a second confirm while one is in flight", () => {
    story(
      update,
      given(initial),
      ...proposeHire,
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      message(Message.ClickedConfirm()),
      model((m) => {
        const again = update(m, Message.ClickedConfirm());
        expect(again.commands ?? []).toEqual([]);
      }),
      Command.resolve(CreateType, Message.SucceededCreateType({ name: "hire" })),
      Command.resolve(Dialog.CloseDialog, Dialog.Message.CompletedCloseDialog()),
      Command.resolve(NavigateToType, Message.CompletedNavigateToType()),
    );
  });

  it("keeps the dialog open with the API's refusal, and closing it drops the pending type", () => {
    story(
      update,
      given(initial),
      ...proposeHire,
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      message(Message.ClickedConfirm()),
      Command.resolve(
        CreateType,
        Message.FailedCreateType({
          failure: apiFailure(409, "TypeAlreadyExists", "Entity type 'hire' already exists"),
        }),
      ),
      model((m) => {
        expect(m.submission._tag).toBe("Failed");
        expect(m.dialog.isOpen).toBe(true);
      }),
      message(Message.GotDialogMessage({ message: Dialog.Message.RequestedClose() })),
      model((m) => {
        expect(m.maybePending).toEqual(Option.none());
        expect(m.submission).toEqual(Submission.Idle());
        expect(m.form.draft.name).toBe(" hire ");
      }),
      Command.resolve(Dialog.CloseDialog, Dialog.Message.CompletedCloseDialog()),
    );
  });
});
