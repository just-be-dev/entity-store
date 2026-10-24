import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import edge from "./edge.ts";
import type { EdgeEnv } from "./edge.ts";
import { admittedEmail, forwardToHub, hubPaths, hubVerifier, isHubPath } from "./hub.ts";
import type { AccessVerifier } from "./identity.ts";
import type { AppEnv } from "./stack.ts";

// Compiles only while the App's real env gives the edge what it reads.
const appEnvFitsEdge = (env: AppEnv): EdgeEnv => env;

const issuer = "https://team.cloudflareaccess.com";
const audience = "app-aud-tag";
const me = "me@just-be.dev";

const keys = Effect.promise(async () => {
  const signing = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: "k1", alg: "RS256" };
  const verifier: AccessVerifier = { issuer, audience, keys: createLocalJWKSet({ keys: [jwk] }) };
  const sign = (
    claims: Record<string, unknown>,
    options: { key?: CryptoKey; aud?: string; exp?: string } = {},
  ) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(issuer)
      .setAudience(options.aud ?? audience)
      .setIssuedAt()
      .setExpirationTime(options.exp ?? "5m")
      .sign(options.key ?? signing.privateKey);
  const person = await sign({ email: me, sub: "person" });
  const serviceToken = await sign({ common_name: "client-id.access", sub: "" });
  return {
    verifier: Option.some(verifier),
    sign,
    otherKey: other.privateKey,
    person,
    serviceToken,
  };
});

/** An Access JWT's shape with any claims, signed by no one. */
const unsigned = (claims: Record<string, unknown>) => {
  const part = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
  return `${part({ alg: "RS256", kid: "k1" })}.${part(claims)}.c2ln`;
};

const request = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
  new Request(`https://entities.just-be.dev${path}`, { headers, ...init });

const signedIn = (jwt: string, email = me) => ({
  "cf-access-authenticated-user-email": email,
  "cf-access-jwt-assertion": jwt,
});

/** Agents' Workers as bindings, recording what reaches them. */
const hub = () => {
  const api: Array<{ url: string; method: string; email: string | null; body: string }> = [];
  const embed: Array<string> = [];
  const env = {
    HUB_API: {
      platformFetch: async (forwarded: Request, email: string | null) => {
        api.push({
          url: forwarded.url,
          method: forwarded.method,
          email,
          body: await forwarded.text(),
        });
        return new Response("api");
      },
    },
    HUB_EMBED: {
      fetch: async (forwarded: Request) => {
        embed.push(forwarded.url);
        return new Response("embed");
      },
    },
  };
  return { api, embed, env };
};

describe("the hub shell's paths", () => {
  it("are /_hub and everything under it, and the Worker runs first for them", () => {
    const hubUrl = (path: string) => isHubPath(new URL(path, "https://entities.just-be.dev"));
    expect(hubUrl("/_hub")).toBe(true);
    expect(hubUrl("/_hub/")).toBe(true);
    expect(hubUrl("/_hub/shell.js")).toBe(true);
    expect(hubUrl("/_hub/api/threads?x=1")).toBe(true);
    expect(hubUrl("/_hubbub")).toBe(false);
    expect(hubUrl("/api/types")).toBe(false);
    expect(hubUrl("/")).toBe(false);
    expect(hubPaths).toEqual(["/_hub", "/_hub/*"]);
  });
});

describe("the admitted email", () => {
  it.effect("is the person in Access's verified JWT when the header names them", () =>
    Effect.gen(function* () {
      const { verifier, person } = yield* keys;
      expect(yield* admittedEmail(request("/", signedIn(person)), verifier)).toBe(me);
      expect(yield* admittedEmail(request("/", signedIn(person, "ME@just-be.dev")), verifier)).toBe(
        me,
      );
    }),
  );

  it.effect("is null for a service token, even with an email header beside it", () =>
    Effect.gen(function* () {
      const { verifier, serviceToken } = yield* keys;
      expect(yield* admittedEmail(request("/", signedIn(serviceToken)), verifier)).toBeNull();
    }),
  );

  it.effect("is null for a header naming someone else, or no header", () =>
    Effect.gen(function* () {
      const { verifier, person } = yield* keys;
      expect(
        yield* admittedEmail(request("/", signedIn(person, "other@just-be.dev")), verifier),
      ).toBeNull();
      expect(
        yield* admittedEmail(request("/", { "cf-access-jwt-assertion": person }), verifier),
      ).toBeNull();
    }),
  );

  it.effect("is null unless the JWT verifies: forged, wrong key, audience or expired", () =>
    Effect.gen(function* () {
      const { verifier, sign, otherKey } = yield* keys;
      const rejected = [
        unsigned({ email: me, iss: issuer, aud: audience, exp: 9_999_999_999 }),
        yield* Effect.promise(() => sign({ email: me }, { key: otherKey })),
        yield* Effect.promise(() => sign({ email: me }, { aud: "another-app" })),
        yield* Effect.promise(() => sign({ email: me }, { exp: "-1m" })),
        "not.a-jwt!.at-all",
      ];
      for (const jwt of rejected) {
        expect(yield* admittedEmail(request("/", signedIn(jwt)), verifier)).toBeNull();
      }
      expect(
        yield* admittedEmail(request("/", { "cf-access-authenticated-user-email": me }), verifier),
      ).toBeNull();
    }),
  );

  it.effect("is null without a verifier (no Access settings, as in alchemy dev)", () =>
    Effect.gen(function* () {
      const { person } = yield* keys;
      expect(yield* admittedEmail(request("/", signedIn(person)), Option.none())).toBeNull();
      expect(Option.isNone(hubVerifier({}))).toBe(true);
      expect(Option.isNone(hubVerifier({ ACCESS_AUD: "", ACCESS_TEAM_DOMAIN: "" }))).toBe(true);
      const deployed = hubVerifier({
        ACCESS_AUD: audience,
        ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      });
      expect(Option.map(deployed, ({ issuer, audience }) => ({ issuer, audience }))).toEqual(
        Option.some({ issuer, audience }),
      );
      // One verifier (and key cache) per isolate for the same settings.
      expect(
        hubVerifier({ ACCESS_AUD: audience, ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com" }),
      ).toBe(deployed);
    }),
  );
});

describe("forwarding to agents", () => {
  it.effect("sends API calls to platformFetch without the prefix, with the admitted email", () =>
    Effect.gen(function* () {
      const { verifier, person, serviceToken } = yield* keys;
      const { api, embed, env } = hub();
      const url = new URL("https://entities.just-be.dev/_hub/api/threads/t1/runs?stream=1");
      const response = yield* Effect.promise(() =>
        forwardToHub(
          request(url.pathname + url.search, signedIn(person), {
            method: "POST",
            body: '{"text":"hi"}',
          }),
          url,
          env,
          verifier,
        ),
      );
      expect(yield* Effect.promise(() => response.text())).toBe("api");
      expect(api).toEqual([
        {
          url: "https://entities.just-be.dev/api/threads/t1/runs?stream=1",
          method: "POST",
          email: me,
          body: '{"text":"hi"}',
        },
      ]);
      expect(embed).toEqual([]);

      // The AgentToken with a forged email header acts for no one.
      const threads = new URL("https://entities.just-be.dev/_hub/api/threads");
      yield* Effect.promise(() =>
        forwardToHub(request(threads.pathname, signedIn(serviceToken)), threads, env, verifier),
      );
      yield* Effect.promise(() =>
        forwardToHub(
          request(threads.pathname, { "cf-access-authenticated-user-email": me }),
          threads,
          env,
          verifier,
        ),
      );
      expect(api.slice(1).map((each) => each.email)).toEqual([null, null]);
    }),
  );

  it.effect("sends everything else under /_hub to agents' Embed Worker unchanged", () =>
    Effect.gen(function* () {
      const { verifier, person } = yield* keys;
      const { api, embed, env } = hub();
      for (const path of ["/_hub/shell.js", "/_hub/", "/_hub/assets/index-abc.js"]) {
        const url = new URL(path, "https://entities.just-be.dev");
        const response = yield* Effect.promise(() =>
          forwardToHub(request(path, signedIn(person)), url, env, verifier),
        );
        expect(yield* Effect.promise(() => response.text())).toBe("embed");
      }
      expect(embed).toEqual([
        "https://entities.just-be.dev/_hub/shell.js",
        "https://entities.just-be.dev/_hub/",
        "https://entities.just-be.dev/_hub/assets/index-abc.js",
      ]);
      expect(api).toEqual([]);
    }),
  );

  it.effect("answers 404 for the shell's paths without agents' bindings (alchemy dev)", () =>
    Effect.gen(function* () {
      for (const path of ["/_hub/shell.js", "/_hub/api/threads"]) {
        const url = new URL(path, "https://entities.just-be.dev");
        const response = yield* Effect.promise(() => forwardToHub(request(path), url, {}));
        expect(response.status).toBe(404);
      }
    }),
  );

  it.effect("the edge sends /_hub to agents and everything else to the API unchanged", () =>
    Effect.gen(function* () {
      const { person } = yield* keys;
      const { api, embed, env: hubEnv } = hub();
      const toApi: Array<string> = [];
      const env: EdgeEnv = {
        ...hubEnv,
        // Blank Access settings, as in alchemy dev: nothing verifies.
        ACCESS_AUD: "",
        ACCESS_TEAM_DOMAIN: "",
        API: {
          fetch: async (forwarded: Request) => {
            toApi.push(
              `${forwarded.url} ${forwarded.headers.get("cf-access-jwt-assertion") === person}`,
            );
            return new Response("entities");
          },
        },
      };
      expect(appEnvFitsEdge).toBeTypeOf("function");
      const text = (path: string) =>
        Effect.promise(async () => (await edge.fetch(request(path, signedIn(person)), env)).text());
      expect(yield* text("/_hub/shell.js")).toBe("embed");
      expect(yield* text("/_hub/api/threads")).toBe("api");
      expect(yield* text("/api/types")).toBe("entities");
      expect(embed).toEqual(["https://entities.just-be.dev/_hub/shell.js"]);
      // No Access settings: nothing verifies, so no one is admitted.
      expect(api.map((each) => each.email)).toEqual([null]);
      expect(toApi).toEqual(["https://entities.just-be.dev/api/types true"]);
    }),
  );
});

describe("the edge's import graph", () => {
  const here = dirname(fileURLToPath(import.meta.url));

  /** Every module the edge loads at runtime, following relative imports; type imports excluded. */
  const runtimeImports = async (entry: string) => {
    const seen = new Set<string>();
    const packages = new Set<string>();
    const visit = async (path: string): Promise<void> => {
      if (seen.has(path)) return;
      seen.add(path);
      const source = await readFile(path, "utf8");
      for (const match of source.matchAll(
        /^\s*(?:import|export)\s+(type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gmu,
      )) {
        const [, typeOnly, specifier] = match;
        if (typeOnly !== undefined || specifier === undefined) continue;
        if (specifier.startsWith(".")) await visit(resolve(dirname(path), specifier));
        else packages.add(specifier);
      }
      for (const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/gu)) {
        if (match[1] !== undefined) packages.add(match[1]);
      }
    };
    await visit(resolve(here, entry));
    return { modules: [...seen], packages: [...packages] };
  };

  it("has no Alchemy or cloudflare: modules, which break the App Worker under alchemy dev", async () => {
    const { modules, packages } = await runtimeImports("edge.ts");
    expect(modules.map((path) => path.slice(here.length + 1)).sort()).toEqual([
      "edge.ts",
      "hub-identity.ts",
      "hub.ts",
      "identity.ts",
    ]);
    expect(packages.filter((name) => /^(alchemy|cloudflare:)/u.test(name))).toEqual([]);
  });

  it("keeps agents' bindings in the plan-time module the stack imports", async () => {
    const { packages } = await runtimeImports("hub-bindings.ts");
    expect(packages).toContain("alchemy/Cloudflare");
    const stack = await readFile(resolve(here, "stack.ts"), "utf8");
    expect(stack).toContain('from "./hub-bindings.ts"');
  });
});
