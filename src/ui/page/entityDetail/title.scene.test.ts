import { describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { expect, given, role, scene, text } from "foldkit/scene";
import { ada, personType, titledPersonType } from "@/domain/entityStore.fixture";
import type { TypeInfo } from "@/domain/entityStore";
import { init, Message, update, view } from "./main.ts";

const loaded = (info: TypeInfo) =>
  [
    Message.SucceededFetchEntity({ requested: Option.none(), entity: ada(), included: {} }),
    Message.SucceededFetchType({ info }),
  ].reduce((model, message) => update(model, message).model, init("ada").model);

describe("entity detail titles", () => {
  it("heads the page with the entity's title, and shows its id below", () => {
    scene(
      { update, view },
      given(loaded(titledPersonType)),
      expect(role("heading", { name: "Ada Lovelace" })).toExist(),
      expect(text("ada")).toExist(),
    );
  });

  it("heads the page with the id when the schema has no title", () => {
    scene(
      { update, view },
      given(loaded(personType)),
      expect(role("heading", { name: "ada" })).toExist(),
    );
  });
});
