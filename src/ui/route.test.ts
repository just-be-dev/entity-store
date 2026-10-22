import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { AppRoute, basePathOf, href, stripBasePath, urlToAppRoute } from "./route.ts";

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

  it("strips a project base path before matching", () => {
    const strip = stripBasePath(basePathOf("/cafe/"));
    expect(strip("/cafe/types/person")).toBe("/types/person");
    expect(strip("/cafe")).toBe("/");
    expect(strip("/cafe/")).toBe("/");
    expect(strip("/cafeteria/x")).toBe("/cafeteria/x");
    expect(stripBasePath(basePathOf("/"))("/types/a")).toBe("/types/a");
  });
});
