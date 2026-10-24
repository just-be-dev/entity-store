import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { underBase } from "./basePath.fixture.ts";
import { AppRoute, href, urlToAppRoute } from "./route.ts";

const url = (pathname: string) => ({
  protocol: "http:",
  host: "localhost",
  port: Option.none(),
  pathname,
  search: Option.none(),
  hash: Option.none(),
});

describe("routes", () => {
  it("parses each screen", () => {
    expect(urlToAppRoute(url("/"))).toEqual(AppRoute.TypeList());
    expect(urlToAppRoute(url("/types/person"))).toEqual(AppRoute.TypeDetail({ name: "person" }));
    expect(urlToAppRoute(url("/types/person/versions/new"))).toEqual(
      AppRoute.NewVersion({ name: "person" }),
    );
    expect(urlToAppRoute(url("/types/person/indexes"))).toEqual(
      AppRoute.TypeIndexes({ name: "person" }),
    );
    expect(urlToAppRoute(url("/entities/ada"))).toEqual(AppRoute.EntityDetail({ id: "ada" }));
    // Encoded or not, an id with `@` reads the same.
    for (const path of ["/entities/ada%40example.com", "/entities/ada@example.com"]) {
      expect(urlToAppRoute(url(path))).toEqual(AppRoute.EntityDetail({ id: "ada@example.com" }));
    }
    expect(urlToAppRoute(url("/entities/100%"))).toEqual(AppRoute.EntityDetail({ id: "100%" }));
    expect(urlToAppRoute(url("/nope/x"))._tag).toBe("NotFound");
  });

  it("prints hrefs that parse back to the same route", () => {
    const routes = [
      AppRoute.TypeList(),
      AppRoute.TypeDetail({ name: "person" }),
      AppRoute.NewVersion({ name: "person" }),
      AppRoute.TypeIndexes({ name: "person" }),
      AppRoute.EntityDetail({ id: "0190-abc" }),
      AppRoute.EntityDetail({ id: "ada.lovelace@example.com" }),
    ];
    expect(routes.map((route) => urlToAppRoute(url(href(route))))).toEqual(routes);
  });

  it("routes and prints under the hub's base path", () => {
    underBase("https://hub.just-be.dev/entities@b-x-123abc/", () => {
      expect(urlToAppRoute(url("/entities@b-x-123abc/types/person"))).toEqual(
        AppRoute.TypeDetail({ name: "person" }),
      );
      expect(urlToAppRoute(url("/entities@b-x-123abc"))).toEqual(AppRoute.TypeList());
      expect(urlToAppRoute(url("/entities@b-x-123abc/"))).toEqual(AppRoute.TypeList());
      expect(href(AppRoute.TypeDetail({ name: "person" }))).toBe(
        "/entities@b-x-123abc/types/person",
      );
      expect(href(AppRoute.TypeList())).toBe("/entities@b-x-123abc/");
    });
    // Prod's base is `/entities/`, the same word as the app's own entity route.
    underBase("https://hub.just-be.dev/entities/", () => {
      const route = AppRoute.EntityDetail({ id: "ada" });
      expect(href(route)).toBe("/entities/entities/ada");
      expect(urlToAppRoute(url(href(route)))).toEqual(route);
      expect(urlToAppRoute(url("/entities/"))).toEqual(AppRoute.TypeList());
    });
  });
});
