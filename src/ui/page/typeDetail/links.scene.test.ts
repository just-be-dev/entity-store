import { describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { expect, given, role, scene, text, within } from "foldkit/scene";
import { ada, post, postType } from "@/domain/entityStore.fixture";
import { init, Message, update, view } from "./main.ts";

const loaded = [
  Message.SucceededFetchType({ info: postType }),
  Message.SucceededFetchEntities({
    version: 1,
    page: { items: [post()], failures: [], nextCursor: Option.none(), included: { ada: ada() } },
  }),
].reduce((m, msg) => update(m, msg).model, init("post").model);

describe("type detail links", () => {
  it("renders each entity's link targets as links, with a preview on hover", () => {
    scene(
      { update, view },
      given(loaded),
      expect(within(role("list", { name: "Links" }), text("author →"))).toExist(),
      expect(role("link", { name: "ada" })).toHaveAttr("href", "/entities/ada"),
      expect(role("link", { name: "ada" })).toHaveAttr(
        "title",
        'person: {"fullName":"Ada Lovelace"}',
      ),
      expect(role("link", { name: "alan" })).toHaveAttr("title", "person not found"),
    );
  });

  it("shows which types a version links to", () => {
    scene({ update, view }, given(loaded), expect(text("links → person")).toExist());
  });
});
