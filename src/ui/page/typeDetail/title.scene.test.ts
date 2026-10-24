import { describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { expect, given, role, scene, text } from "foldkit/scene";
import { ada, titledPersonType } from "@/domain/entityStore.fixture";
import { init, Message, update, view } from "./index.ts";

const withEntities = [
  Message.SucceededFetchType({ info: titledPersonType }),
  Message.SucceededFetchEntities({
    version: 2,
    page: {
      items: [ada(), ada({ id: "anon", data: { fullName: "" } })],
      failures: [],
      nextCursor: Option.none(),
    },
  }),
].reduce((model, message) => update(model, message).model, init("person").model);

describe("type detail titles", () => {
  it("shows each entity's title above its id, when it has one", () => {
    scene(
      { update, view },
      given(withEntities),
      expect(text("Ada Lovelace")).toExist(),
      expect(role("link", { name: "ada" })).toHaveAttr("href", "/entities/ada"),
      expect(role("link", { name: "anon" })).toHaveAttr("href", "/entities/anon"),
    );
  });
});
