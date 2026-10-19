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
  it("renders the active page inside the app shell", () => {
    scene(
      { update, view },
      given(init(url("/")).model),
      expect(role("navigation", { name: "Main" })).toExist(),
      expect(role("link", { name: "Types" })).toHaveAttr("aria-current", "page"),
      expect(role("heading", { name: "Entity types" })).toExist(),
      expect(text("Loading types…")).toExist(),
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
