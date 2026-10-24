import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { hubRedirect, hubRedirectConfig, redirectTo } from "./hub-redirect.ts";

const hubClientId = "hub-client.access";
const prod = hubRedirectConfig({ HUB_FRAME_PREFIX: "/entities", HUB_CLIENT_ID: hubClientId });
const preview = hubRedirectConfig({
  HUB_FRAME_PREFIX: "/entities@b-feature-1a2b3c",
  HUB_CLIENT_ID: hubClientId,
});

const navigation = { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" };

/** An Access JWT's shape with any claims, signed by no one (the edge doesn't verify). */
const jwt = (claims: Record<string, unknown>) => {
  const part = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
  return `${part({ alg: "RS256", kid: "k1" })}.${part(claims)}.c2ln`;
};

const where = (
  path: string,
  options: { headers?: Record<string, string>; method?: string; config?: typeof prod } = {},
) => {
  const url = new URL(`https://entity-store.just-be.dev${path}`);
  const request = new Request(url, {
    method: options.method ?? "GET",
    headers: options.headers ?? navigation,
  });
  return hubRedirect(request, url, options.config ?? prod);
};

describe("hubRedirect", () => {
  it("sends a page load to the same path on the hub, query kept", () => {
    expect(where("/")).toEqual(Option.some("https://hub.just-be.dev/entities/"));
    expect(where("/types/person?x=1")).toEqual(
      Option.some("https://hub.just-be.dev/entities/types/person?x=1"),
    );
    expect(where("/types/person/versions/new")).toEqual(
      Option.some("https://hub.just-be.dev/entities/types/person/versions/new"),
    );
    expect(where("/entities/ada", { method: "HEAD" })).toEqual(
      Option.some("https://hub.just-be.dev/entities/entities/ada"),
    );
  });

  it("sends a preview to its stage on the hub", () => {
    expect(where("/types/person", { config: preview })).toEqual(
      Option.some("https://hub.just-be.dev/entities@b-feature-1a2b3c/types/person"),
    );
  });

  it("treats entity ids and type names with dots as pages", () => {
    expect(where("/entities/ada.lovelace@example.com")).toEqual(
      Option.some("https://hub.just-be.dev/entities/entities/ada.lovelace@example.com"),
    );
    expect(where("/entities/ada%40example.com")).toEqual(
      Option.some("https://hub.just-be.dev/entities/entities/ada%40example.com"),
    );
    expect(Option.isSome(where("/types/v1.2"))).toBe(true);
  });

  it("leaves everything that isn't a person's top-level page load", () => {
    for (const headers of [
      {} as Record<string, string>,
      { "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate" },
      { "sec-fetch-dest": "document", "sec-fetch-mode": "cors" },
      { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" },
      { "sec-fetch-dest": "document" },
    ]) {
      expect(where("/types/person", { headers })).toEqual(Option.none());
    }
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      expect(where("/types/person", { method })).toEqual(Option.none());
    }
  });

  it("leaves non-page paths", () => {
    for (const path of [
      "/api",
      "/api/types",
      "/mcp",
      "/mcp/x",
      "/mcpx",
      "/_hub",
      "/_hub/shell.js",
      "/.well-known/security.txt",
      "/cdn-cgi/access/logout",
      "/assets/index-abc.js",
      "/favicon.ico",
      "/robots.txt",
    ]) {
      expect(where(path)).toEqual(Option.none());
    }
  });

  it("leaves the hub's own proxied requests, by the client id in Access's JWT", () => {
    const fromHub = { ...navigation, "cf-access-jwt-assertion": jwt({ common_name: hubClientId }) };
    expect(where("/types/person", { headers: fromHub })).toEqual(Option.none());
    for (const other of [
      jwt({ common_name: "agent.access" }),
      jwt({ email: "me@just-be.dev" }),
      "not-a-jwt",
      "a.!!!.c",
      `a.${btoa("[1]")}.c`,
    ]) {
      expect(
        where("/types/person", { headers: { ...navigation, "cf-access-jwt-assertion": other } }),
      ).toEqual(Option.some("https://hub.just-be.dev/entities/types/person"));
    }
  });

  it("does nothing without both bindings, as under alchemy dev", () => {
    for (const env of [
      {},
      { HUB_FRAME_PREFIX: "", HUB_CLIENT_ID: "" },
      { HUB_FRAME_PREFIX: "/entities", HUB_CLIENT_ID: " " },
      { HUB_FRAME_PREFIX: "", HUB_CLIENT_ID: hubClientId },
      { HUB_FRAME_PREFIX: "entities", HUB_CLIENT_ID: hubClientId },
    ]) {
      expect(where("/types/person", { config: hubRedirectConfig(env) })).toEqual(Option.none());
    }
  });
});

it("redirects with a 302 nothing caches", () => {
  const response = redirectTo("https://hub.just-be.dev/entities/");
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("https://hub.just-be.dev/entities/");
  expect(response.headers.get("cache-control")).toBe("no-store");
});
