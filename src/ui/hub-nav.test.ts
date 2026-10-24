import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { modifyFields } from "foldkit/struct";
import type { Url } from "foldkit/url";
import { Box } from "lucide";
import { ada, apiFailure } from "@/domain/entityStore.fixture";
import { underBase } from "./basePath.fixture.ts";
import { HubNav, hubNavOf, iconOf } from "./hub-nav.ts";
import { init, Message, type Model, NavTypes, update } from "./main.ts";
import { EntityDetail } from "./page/index.ts";

const url = (pathname: string): Url => ({
  protocol: "http:",
  host: "localhost",
  port: Option.none(),
  pathname,
  search: Option.none(),
  hash: Option.none(),
});

const at = (pathname: string, navTypes: NavTypes): Model =>
  modifyFields(init(url(pathname)).model, { navTypes: () => navTypes });

const loaded = NavTypes.Loaded({ names: ["person", "post"] });

const typesGroup = (model: Model) => hubNavOf(model).groups[1];

describe("hubNavOf", () => {
  it("speaks protocol version 1 with client-side links", () => {
    const nav = hubNavOf(at("/", loaded));
    expect(nav.version).toBe(1);
    expect(nav.navigation).toBe("history");
    expect(Schema.is(HubNav)(nav)).toBe(true);
    expect(JSON.parse(JSON.stringify(nav))).toEqual(nav);
  });

  it("links the type list, marked current on the list page only", () => {
    expect(hubNavOf(at("/", loaded)).groups[0]?.items).toEqual([
      expect.objectContaining({ label: "All types", href: "/", current: true }),
    ]);
    expect(hubNavOf(at("/types/person", loaded)).groups[0]?.items[0]?.current).toBeUndefined();
  });

  it("lists each type in mono, linking to its page, with none current on the list page", () => {
    expect(typesGroup(at("/", loaded))).toEqual({
      label: "Entity types",
      items: [
        { label: "person", href: "/types/person", icon: iconOf(Box), mono: true },
        { label: "post", href: "/types/post", icon: iconOf(Box), mono: true },
      ],
    });
  });

  it("links under the hub's base, so the shell gets hub paths", () => {
    underBase("https://hub.just-be.dev/entities/", () => {
      const nav = hubNavOf(at("/entities/types/person", loaded));
      expect(nav.groups[0]?.items[0]?.href).toBe("/entities/");
      expect(nav.groups[1]?.items.map((item) => [item.href, item.current])).toEqual([
        ["/entities/types/person", true],
        ["/entities/types/post", undefined],
      ]);
    });
  });

  it("marks the type the open page is about", () => {
    const currentOn = (pathname: string) =>
      typesGroup(at(pathname, loaded))
        ?.items.filter((item) => item.current === true)
        .map((item) => item.label);
    expect(currentOn("/types/person")).toEqual(["person"]);
    expect(currentOn("/types/post/versions/new")).toEqual(["post"]);
    expect(currentOn("/types/person/indexes")).toEqual(["person"]);
    expect(currentOn("/nowhere")).toEqual([]);
  });

  it("marks a shown entity's type once the entity loads", () => {
    const loading = at("/entities/ada", loaded);
    expect(typesGroup(loading)?.items.some((item) => item.current === true)).toBe(false);
    const shown = update(
      loading,
      Message.GotEntityDetailMessage({
        message: EntityDetail.Message.SucceededFetchEntity({
          requested: Option.none(),
          entity: ada(),
          included: {},
        }),
      }),
    ).model;
    expect(typesGroup(shown)?.items.find((item) => item.current === true)?.label).toBe("person");
  });

  it("notes loading, empty and failed type lists in place of items", () => {
    expect(typesGroup(at("/", NavTypes.Loading()))).toEqual({
      label: "Entity types",
      items: [],
      note: "Loading…",
      noteTone: "muted",
    });
    expect(typesGroup(at("/", NavTypes.Loaded({ names: [] })))).toEqual({
      label: "Entity types",
      items: [],
      note: "No entity types yet.",
      noteTone: "muted",
    });
    expect(
      typesGroup(
        at("/", NavTypes.Failed({ failure: apiFailure(500, "StorageFailure", "Storage error") })),
      ),
    ).toEqual({
      label: "Entity types",
      items: [],
      note: "Couldn't load entity types: Storage error",
      noteTone: "error",
    });
  });
});

describe("iconOf", () => {
  it("carries lucide's attributes as strings", () => {
    expect(iconOf([["circle", { cx: 12, r: "4", fill: undefined }]])).toEqual([
      ["circle", { cx: "12", r: "4" }],
    ]);
  });
});
