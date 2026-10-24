import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { AccessVerifier, HubTrust, RequestCredentials } from "./identity.ts";
import {
  hubTrustFrom,
  principalFromAccess,
  remoteVerifier,
  requestPrincipal,
  teamIssuer,
  verifyAccessToken,
} from "./identity.ts";
import { signWithTestKey, testClaims, testPublicKeyPem } from "./testing/hub-identity-vector.ts";

const issuer = "https://team.cloudflareaccess.com";
const audience = "app-aud-tag";

const keys = Effect.promise(async () => {
  const signing = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: "k1", alg: "RS256" };
  const verifier: AccessVerifier = { issuer, audience, keys: createLocalJWKSet({ keys: [jwk] }) };
  const sign = (
    claims: Record<string, unknown>,
    options: { key?: CryptoKey; iss?: string; aud?: string; exp?: string } = {},
  ) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(options.iss ?? issuer)
      .setAudience(options.aud ?? audience)
      .setIssuedAt()
      .setExpirationTime(options.exp ?? "5m")
      .sign(options.key ?? signing.privateKey);
  return { verifier, sign, otherKey: other.privateKey };
});

describe("principals from Cloudflare Access", () => {
  it("uses the email for people and the client id for service tokens", () => {
    expect(principalFromAccess({ email: "cf@just-be.dev" })).toEqual({
      _tag: "User",
      email: "cf@just-be.dev",
    });
    expect(principalFromAccess({ email: "", common_name: "abc.access" })).toEqual({
      _tag: "ServiceToken",
      name: "abc.access",
    });
    // Access admitted the request, so no identity payload still means a token.
    expect(principalFromAccess(undefined)).toEqual({ _tag: "ServiceToken", name: "service-token" });
  });

  it("normalizes the team domain into the token issuer", () => {
    expect(teamIssuer("team.cloudflareaccess.com")).toBe(issuer);
    expect(teamIssuer(" https://team.cloudflareaccess.com/ ")).toBe(issuer);
    expect(Option.isNone(remoteVerifier("team.cloudflareaccess.com", ""))).toBe(true);
    expect(Option.isNone(remoteVerifier("bad host/", audience))).toBe(true);
  });
});

describe("Access token verification", () => {
  it.effect("accepts a valid token for a person or a service token", () =>
    Effect.gen(function* () {
      const { verifier, sign } = yield* keys;
      const user = yield* Effect.promise(() => sign({ email: "cf@just-be.dev" }));
      expect(yield* verifyAccessToken(user, verifier)).toEqual(
        Option.some({ _tag: "User", email: "cf@just-be.dev" }),
      );
      const token = yield* Effect.promise(() => sign({ common_name: "abc.access", type: "app" }));
      expect(yield* verifyAccessToken(token, verifier)).toEqual(
        Option.some({ _tag: "ServiceToken", name: "abc.access" }),
      );
    }),
  );

  it.effect("rejects missing, forged, expired, or misdirected tokens", () =>
    Effect.gen(function* () {
      const { verifier, sign, otherKey } = yield* keys;
      const claims = { email: "cf@just-be.dev" };
      const bad = yield* Effect.promise(() =>
        Promise.all([
          sign(claims, { key: otherKey }),
          sign(claims, { iss: "https://evil.cloudflareaccess.com" }),
          sign(claims, { aud: "some-other-app" }),
          sign(claims, { exp: "-1m" }),
        ]),
      );
      const unsigned = `${btoa(JSON.stringify({ alg: "none" }))}.${btoa(JSON.stringify({ ...claims, iss: issuer, aud: audience }))}.`;
      for (const token of [undefined, "", "not-a-jwt", unsigned, ...bad]) {
        expect(yield* verifyAccessToken(token, verifier)).toEqual(Option.none());
      }
    }),
  );
});

describe("the hub's identity", () => {
  const hubClientId = "hub-client.access";
  const audienceHere = "entities@prod";
  const hubTrust = (env: Record<string, unknown>) => hubTrustFrom(env);
  const trusted = hubTrust({
    HUB_CLIENT_ID: hubClientId,
    HUB_PUBLIC_KEY: testPublicKeyPem,
    HUB_AUDIENCE: audienceHere,
  });
  const nowSeconds = testClaims.iat + 10;
  const now = nowSeconds * 1000;
  const identityFor = (claims: Record<string, unknown> = {}) =>
    signWithTestKey({ ...testClaims, aud: audienceHere, ...claims });
  const owner = Option.some({ _tag: "User", email: "owner@just-be.dev" });

  const principal = (
    credentials: Partial<RequestCredentials>,
    verifier: Option.Option<AccessVerifier>,
    hub: Option.Option<HubTrust> = trusted,
  ) =>
    requestPrincipal(
      { access: Option.none(), jwt: undefined, hubIdentity: undefined, ...credentials },
      verifier,
      hub,
      now,
    );

  it("is configured only when every binding is set", () => {
    expect(Option.isSome(trusted)).toBe(true);
    for (const env of [
      {},
      { HUB_CLIENT_ID: "", HUB_PUBLIC_KEY: testPublicKeyPem, HUB_AUDIENCE: audienceHere },
      { HUB_CLIENT_ID: hubClientId, HUB_PUBLIC_KEY: " ", HUB_AUDIENCE: audienceHere },
      { HUB_CLIENT_ID: hubClientId, HUB_PUBLIC_KEY: testPublicKeyPem },
      { HUB_CLIENT_ID: 1, HUB_PUBLIC_KEY: testPublicKeyPem, HUB_AUDIENCE: audienceHere },
    ]) {
      expect(Option.isNone(hubTrust(env))).toBe(true);
    }
  });

  it.effect("names the person the hub's signed token vouches for, through the Website", () =>
    Effect.gen(function* () {
      const { verifier, sign } = yield* keys;
      const hubJwt = yield* Effect.promise(() => sign({ common_name: hubClientId, sub: "" }));
      const identity = yield* Effect.promise(() => identityFor());
      expect(
        yield* principal({ jwt: hubJwt, hubIdentity: identity }, Option.some(verifier)),
      ).toEqual(owner);
    }),
  );

  it.effect("leaves the hub's token no one without a valid identity token", () =>
    Effect.gen(function* () {
      const { verifier, sign } = yield* keys;
      const hubJwt = yield* Effect.promise(() => sign({ common_name: hubClientId, sub: "" }));
      const tokens = yield* Effect.promise(() =>
        Promise.all([
          identityFor({ aud: "entities@b-preview-123abc" }),
          identityFor({ aud: "desk@prod" }),
          identityFor({ exp: testClaims.iat - 120, iat: testClaims.iat - 200 }),
          Promise.resolve("garbage"),
        ]),
      );
      for (const hubIdentity of [undefined, ...tokens]) {
        expect(yield* principal({ jwt: hubJwt, hubIdentity }, Option.some(verifier))).toEqual(
          Option.none(),
        );
      }
      // Straight through Access (the API's workers.dev URL), too: `ctx.access` without an email.
      expect(
        yield* principal(
          { access: Option.some({ email: undefined }), jwt: hubJwt },
          Option.some(verifier),
        ),
      ).toEqual(Option.none());
      expect(
        yield* principal(
          {
            access: Option.some({ email: undefined }),
            jwt: hubJwt,
            hubIdentity: yield* Effect.promise(() => identityFor()),
          },
          Option.some(verifier),
        ),
      ).toEqual(owner);
    }),
  );

  it.effect("never trusts the identity header beside another credential", () =>
    Effect.gen(function* () {
      const { verifier, sign, otherKey } = yield* keys;
      const identity = yield* Effect.promise(() => identityFor());
      const forged = yield* Effect.promise(() =>
        sign({ common_name: hubClientId, sub: "" }, { key: otherKey }),
      );
      expect(
        yield* principal({ jwt: forged, hubIdentity: identity }, Option.some(verifier)),
      ).toEqual(Option.none());
      // The agent's own service token stays itself.
      const agent = yield* Effect.promise(() => sign({ common_name: "agent.access", sub: "" }));
      expect(
        yield* principal({ jwt: agent, hubIdentity: identity }, Option.some(verifier)),
      ).toEqual(Option.some({ _tag: "ServiceToken", name: "agent.access" }));
      // A person's own Access identity wins, whether from `ctx.access` or the JWT.
      const person = yield* Effect.promise(() => sign({ email: "me@just-be.dev" }));
      expect(
        yield* principal({ jwt: person, hubIdentity: identity }, Option.some(verifier)),
      ).toEqual(Option.some({ _tag: "User", email: "me@just-be.dev" }));
      expect(
        yield* principal(
          { access: Option.some({ email: "me@just-be.dev" }), hubIdentity: identity },
          Option.none(),
        ),
      ).toEqual(Option.some({ _tag: "User", email: "me@just-be.dev" }));
      // No Access JWT at all: the header alone is no one.
      expect(yield* principal({ hubIdentity: identity }, Option.some(verifier))).toEqual(
        Option.none(),
      );
    }),
  );

  it.effect("without the hub's bindings, its token is just a service token", () =>
    Effect.gen(function* () {
      const { verifier, sign } = yield* keys;
      const hubJwt = yield* Effect.promise(() => sign({ common_name: hubClientId, sub: "" }));
      const identity = yield* Effect.promise(() => identityFor());
      expect(
        yield* principal(
          { jwt: hubJwt, hubIdentity: identity },
          Option.some(verifier),
          Option.none(),
        ),
      ).toEqual(Option.some({ _tag: "ServiceToken", name: hubClientId }));
    }),
  );

  it.effect("names a service token straight through Access only by its verified JWT", () =>
    Effect.gen(function* () {
      const { verifier, sign } = yield* keys;
      const agent = yield* Effect.promise(() => sign({ common_name: "agent.access", sub: "" }));
      const through = Option.some({ email: undefined });
      expect(yield* principal({ access: through, jwt: agent }, Option.some(verifier))).toEqual(
        Option.some({ _tag: "ServiceToken", name: "agent.access" }),
      );
      for (const jwt of [undefined, "garbage"]) {
        expect(yield* principal({ access: through, jwt }, Option.some(verifier))).toEqual(
          Option.none(),
        );
      }
    }),
  );
});
