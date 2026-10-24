import { describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { Dialog } from "@foldkit/ui";
import {
  Command,
  Mount,
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
import { ada, apiFailure, post, postType } from "@/domain/entityStore.fixture";
import { FetchBacklinks, FetchUsage, init, Message, update, view } from "./main.ts";

const loaded = [
  Message.SucceededFetchEntity({
    requested: Option.none(),
    entity: post(),
    included: { ada: ada() },
  }),
  Message.SucceededFetchType({ info: postType }),
  Message.SucceededFetchBacklinks({
    page: { items: [{ source: "n1", type: "note", path: "about" }], nextCursor: Option.some("n1") },
  }),
].reduce((m, msg) => update(m, msg).model, init("p1").model);

describe("entity links", () => {
  it("lists outgoing links by path with the target's type and a preview", () => {
    scene(
      { update, view },
      given(loaded),
      expect(within(role("list", { name: "Outgoing links" }), text("author"))).toExist(),
      expect(role("link", { name: "ada" })).toHaveAttr("href", "/entities/ada"),
      expect(text('person · {"fullName":"Ada Lovelace"}')).toExist(),
      expect(text("reviewers[]")).toExist(),
      expect(text("person not found")).toExist(),
    );
  });

  it("lists backlinks with links to their sources", () => {
    scene(
      { update, view },
      given(loaded),
      expect(role("link", { name: "n1" })).toHaveAttr("href", "/entities/n1"),
      expect(text("note · about")).toExist(),
      expect(role("button", { name: "More backlinks" })).toExist(),
    );
  });

  it("refuses a delete while something links here, naming who", () => {
    scene(
      { update, view },
      given(loaded),
      click(role("button", { name: "Delete entity" })),
      Command.resolveAll([Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()]),
      Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
      Command.resolve(
        FetchUsage,
        Message.FailedFetchUsage({ failure: apiFailure(0, "x", "offline") }),
      ),
      Command.resolve(
        FetchBacklinks,
        Message.SucceededFetchBacklinks({
          page: {
            items: [{ source: "n9", type: "note", path: "about" }],
            nextCursor: Option.none(),
          },
        }),
      ),
      expect(role("dialog")).toContainText("Other entities link to it: n9 (note, about)"),
      expect(role("button", { name: "Delete" })).toBeDisabled(),
    );
  });

  it("shows each invalid link the dry run rejected", () => {
    scene(
      { update, view },
      given(loaded),
      type(label("title"), "Changed"),
      submit(role("form", { name: "Edit post" })),
      Command.resolve(
        EntityForm.CheckWrite,
        EntityForm.Message.FailedCheckWrite({
          failure: apiFailure(422, "LinkTargetInvalid", "Some links are invalid", {
            problems: [
              { path: "author", target: "nobody", message: "no entity 'nobody'" },
              { path: "reviewers[]", target: "p0", message: "'p0' is a post, not a person" },
            ],
          }),
        }),
      ),
      expect(within(role("list", { name: "Invalid links" }), text("nobody"))).toExist(),
      expect(text("'p0' is a post, not a person")).toExist(),
    );
  });
});
