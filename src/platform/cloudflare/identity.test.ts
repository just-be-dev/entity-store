import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { AccessVerifier } from "./identity.ts";
import { principalFromAccess, remoteVerifier, teamIssuer, verifyAccessToken } from "./identity.ts";

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
