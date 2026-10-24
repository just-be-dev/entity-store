import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { UrlRequest } from "foldkit/navigation";
import type { Url } from "foldkit/url";
import {
  appBase,
  followWithinBase,
  isUnderBase,
  stripBase,
  stripUrl,
  withAppBase,
  withBase,
} from "./basePath.ts";

const base = "/entities@b-rollout-entities-123abc/";
const origin = "https://hub.just-be.dev";

describe("stripBase", () => {
  it("drops the base from paths under it", () => {
    expect(stripBase(base, `${base}types/person`)).toBe("/types/person");
    expect(stripBase(base, `${base}entities/ada`)).toBe("/entities/ada");
    expect(stripBase(base, base)).toBe("/");
    expect(stripBase(base, "/entities@b-rollout-entities-123abc")).toBe("/");
    expect(stripBase("/entities/", "/entities/types/person")).toBe("/types/person");
  });

  it("leaves other paths alone", () => {
    expect(stripBase(base, "/types/person")).toBe("/types/person");
    expect(stripBase(base, "/entities@b-rollout-entities-123abcx/types")).toBe(
      "/entities@b-rollout-entities-123abcx/types",
    );
    expect(stripBase("/entities/", "/entities@x/types")).toBe("/entities@x/types");
    expect(stripBase("/", "/types")).toBe("/types");
    expect(stripBase("/", "/")).toBe("/");
  });

  it("keeps the app's own /entities/ route at the root", () => {
    expect(stripBase("/", "/entities/ada")).toBe("/entities/ada");
    expect(stripBase("/entities/", "/entities/entities/ada")).toBe("/entities/ada");
  });
});

describe("isUnderBase", () => {
  it("says which paths belong to the app", () => {
    expect(isUnderBase(base, `${base}types`)).toBe(true);
    expect(isUnderBase(base, "/entities@b-rollout-entities-123abc")).toBe(true);
    expect(isUnderBase(base, "/desk/")).toBe(false);
    expect(isUnderBase(base, "/entities/types")).toBe(false);
    expect(isUnderBase("/entities/", "/entities@x/types")).toBe(false);
    expect(isUnderBase("/", "/anything")).toBe(true);
  });
});

describe("withBase", () => {
  it("prefixes root-relative paths, keeping the query and hash", () => {
    expect(withBase(base, "/", origin)).toBe(base);
    expect(withBase(base, "/types/person", origin)).toBe(`${base}types/person`);
    expect(withBase(base, "/?x=1", origin)).toBe(`${base}?x=1`);
    expect(withBase(base, "/api/types", origin)).toBe(`${base}api/types`);
    expect(withBase(base, "/entities/a#c", origin)).toBe(`${base}entities/a#c`);
  });

  it("prefixes same-origin full URLs and keeps the origin", () => {
    expect(withBase(base, `${origin}/types?x=1`, origin)).toBe(`${origin}${base}types?x=1`);
    expect(withBase(base, `${origin}/`, origin)).toBe(`${origin}${base}`);
  });

  it("leaves other origins, protocol-relative and relative URLs alone", () => {
    expect(withBase(base, "https://example.com/types", origin)).toBe("https://example.com/types");
    expect(withBase(base, "//example.com/x", origin)).toBe("//example.com/x");
    expect(withBase(base, "types", origin)).toBe("types");
    expect(withBase(base, "?x=1", origin)).toBe("?x=1");
    expect(withBase(base, "mailto:me@example.com", origin)).toBe("mailto:me@example.com");
  });

  it("prefixes every app path, even one that starts like the base", () => {
    // Prod's base and the app's entity route share a word.
    expect(withBase("/entities/", "/entities/ada", origin)).toBe("/entities/entities/ada");
    expect(withBase("/entities/", `${origin}/entities/ada`, origin)).toBe(
      `${origin}/entities/entities/ada`,
    );
    expect(withBase(base, base, origin)).toBe(`${base}${base.slice(1)}`);
  });

  it("changes nothing at the root", () => {
    expect(withBase("/", "/types", origin)).toBe("/types");
    expect(withBase("/", `${origin}/types`, origin)).toBe(`${origin}/types`);
  });
});

it("stripUrl strips a Foldkit Url's pathname", () => {
  const url: Url = {
    protocol: "https:",
    host: "hub.just-be.dev",
    port: Option.none(),
    pathname: `${base}types/person`,
    search: Option.some("x=1"),
    hash: Option.none(),
  };
  expect(stripUrl(url, base)).toEqual({ ...url, pathname: "/types/person" });
  expect(stripUrl(url, "/")).toEqual(url);
});

it("without a document, the base is the root and URLs are unchanged", () => {
  expect(appBase()).toBe("/");
  expect(withAppBase("/types")).toBe("/types");
});

it("the base is the first <base>'s pathname", () => {
  const withDocument = (baseHref: string | undefined) => {
    const previous = globalThis.document;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { querySelector: () => (baseHref === undefined ? null : { href: baseHref }) },
    });
    try {
      return appBase();
    } finally {
      Object.defineProperty(globalThis, "document", { configurable: true, value: previous });
    }
  };
  expect(withDocument(`${origin}${base}`)).toBe(base);
  expect(withDocument(`${origin}/entities`)).toBe("/entities/");
  expect(withDocument(`${origin}/`)).toBe("/");
  expect(withDocument(undefined)).toBe("/");
});

it("follows links outside the base as documents", () => {
  const at = (pathname: string): Url => ({
    protocol: "https:",
    host: "hub.just-be.dev",
    port: Option.none(),
    pathname,
    search: Option.some("q=1"),
    hash: Option.none(),
  });
  const inside = UrlRequest.Internal({ url: at(`${base}types`) });
  expect(followWithinBase(inside, base)).toEqual(inside);
  expect(followWithinBase(UrlRequest.Internal({ url: at("/desk/projects") }), base)).toEqual(
    UrlRequest.External({ href: "https://hub.just-be.dev/desk/projects?q=1" }),
  );
  const external = UrlRequest.External({ href: "https://example.com/" });
  expect(followWithinBase(external, base)).toEqual(external);
  const anywhere = UrlRequest.Internal({ url: at("/desk/projects") });
  expect(followWithinBase(anywhere, "/")).toEqual(anywhere);
});
