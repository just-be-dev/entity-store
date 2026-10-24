import { describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { expect, given, role, scene, text } from "foldkit/scene";
import { init, update, view } from "./main.ts";

const url = (pathname: string) => ({
  protocol: "http:",
  host: "localhost",
  port: Option.none(),
  pathname,
  search: Option.none(),
  hash: Option.none(),
});

describe("root", () => {
  it("renders the active page in the panel, leaving navigation to the hub's sidebar", () => {
    scene(
      { update, view },
      given(init(url("/")).model),
      expect(role("banner")).toContainText("Entity types"),
      expect(role("navigation")).toBeAbsent(),

      expect(role("heading", { name: "Entity types" })).toExist(),
      expect(text("Loading types…")).toExist(),
    );
  });

  it("names the open page in the panel header", () => {
    scene(
      { update, view },
      given(init(url("/types/person/indexes")).model),
      expect(role("banner")).toHaveText("person · Indexes"),
    );
  });

  it("renders a not-found page with a way home", () => {
    scene(
      { update, view },
      given(init(url("/nowhere")).model),
      expect(role("heading", { name: "Page not found" })).toExist(),
      expect(role("link", { name: "All types" })).toHaveAttr("href", "/"),
    );
  });
});
