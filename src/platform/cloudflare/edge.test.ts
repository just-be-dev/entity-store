import { describe, expect, it } from "@effect/vitest";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import edge, { assetHeaders, type EdgeEnv } from "./edge.ts";

const here = dirname(fileURLToPath(import.meta.url));
const navigation = { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" };

/** The App's bindings, recording where each request went. */
const app = (
  bindings: Record<string, unknown> = {},
  assetResponse = () => new Response("page"),
) => {
  const seen: Array<string> = [];
  const env: EdgeEnv = {
    ACCESS_AUD: "",
    ACCESS_TEAM_DOMAIN: "",
    HUB_FRAME_PREFIX: "/entities@b-feature-1a2b3c",
    HUB_CLIENT_ID: "hub-client.access",
    API: {
      fetch: async (request: Request) => {
        seen.push(`api ${new URL(request.url).pathname}`);
        return new Response("api");
      },
    },
    ASSETS: {
      fetch: async (request: Request) => {
        seen.push(`assets ${new URL(request.url).pathname}`);
        return assetResponse();
      },
    },
    ...bindings,
  };
  const send = (path: string, headers: Record<string, string> = navigation) =>
    edge.fetch(new Request(`https://entity-store-b.example.workers.dev${path}`, { headers }), env);
  return { seen, send };
};

describe("the edge", () => {
  it("sends a person's page load on its own hostname to the hub", async () => {
    const { seen, send } = app();
    const response = await send("/types/person?x=1");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://hub.just-be.dev/entities@b-feature-1a2b3c/types/person?x=1",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(seen).toEqual([]);
  });

  it("serves the hub's framed loads, and everything not a page load, from the build", async () => {
    const { seen, send } = app();
    expect(await (await send("/types/person", { "sec-fetch-dest": "iframe" })).text()).toBe("page");
    expect(await (await send("/assets/index.js", {})).text()).toBe("page");
    expect(await (await send("/api/types")).text()).toBe("api");
    expect(seen).toEqual(["assets /types/person", "assets /assets/index.js", "api /api/types"]);
  });

  it("keeps _headers' policy on what it serves from the build", async () => {
    const { send } = app();
    const served = await send("/", { "sec-fetch-dest": "iframe" });
    expect(served.headers.get("content-security-policy")).toBe(
      assetHeaders["content-security-policy"],
    );
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    // A policy Cloudflare already applied stays as it is.
    const applied = app(
      {},
      () => new Response("page", { headers: { "content-security-policy": "x" } }),
    );
    const kept = await applied.send("/", { "sec-fetch-dest": "iframe" });
    expect(kept.headers.get("content-security-policy")).toBe("x");
    expect(kept.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("redirects nothing without the hub's bindings, as under alchemy dev", async () => {
    const { seen, send } = app({ HUB_FRAME_PREFIX: "", HUB_CLIENT_ID: "" });
    expect((await send("/types/person")).status).toBe(200);
    expect(seen).toEqual(["assets /types/person"]);
  });

  it("falls back to the API without an ASSETS binding", async () => {
    const { seen, send } = app({ ASSETS: undefined, HUB_FRAME_PREFIX: "" });
    expect(await (await send("/types/person")).text()).toBe("api");
    expect(seen).toEqual(["api /types/person"]);
  });
});

it("asset headers match public/_headers", async () => {
  const file = await readFile(resolve(here, "../../../public/_headers"), "utf8");
  const rules = file
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
    });
  expect(file.split("\n")[0]?.trim()).toBe("/*");
  expect(Object.fromEntries(rules)).toEqual(assetHeaders);
});
