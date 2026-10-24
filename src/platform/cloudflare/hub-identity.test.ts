import { expect, it as test } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { hubIdentityVerifier, kidOf } from "./hub-identity.ts";
import {
  signWithTestKey,
  testAudience,
  testClaims,
  testJwt,
  testKid,
  testNow,
  testPublicKeyPem,
} from "./testing/hub-identity-vector.ts";

const verify = (token: string, nowMillis = testNow, audience = testAudience) =>
  Effect.runPromise(
    hubIdentityVerifier({ publicKeyPem: testPublicKeyPem, audience })(token, nowMillis),
  );

const base64Url = (text: string) =>
  btoa(text).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");

const sign = signWithTestKey;

test("the key id is the shared vector's", async () => {
  expect(await Effect.runPromise(kidOf(testPublicKeyPem))).toEqual(Option.some(testKid));
  expect(await Effect.runPromise(kidOf("not a key"))).toEqual(Option.none());
});

test("the shared vector verifies for its audience while it's fresh", async () => {
  expect(await verify(testJwt)).toEqual(Option.some("owner@just-be.dev"));
  // Signed by this test, too.
  expect(await verify(await sign(testClaims))).toEqual(Option.some("owner@just-be.dev"));
});

test("an expired token is refused", async () => {
  expect(await verify(testJwt, 1798761900000)).toEqual(Option.none());
});

test("a token for another audience is refused", async () => {
  expect(await verify(testJwt, testNow, "desk@prod")).toEqual(Option.none());
  expect(await verify(testJwt, testNow, "entities@prod")).toEqual(Option.none());
  const forEntities = await sign({ ...testClaims, aud: "entities@prod" });
  expect(await verify(forEntities, testNow, "entities@prod")).toEqual(
    Option.some("owner@just-be.dev"),
  );
  expect(await verify(forEntities, testNow, "entities@b-preview-123abc")).toEqual(Option.none());
});

test("a token issued in the future, or claiming too long a life, is refused", async () => {
  expect(await verify(testJwt, (testClaims.iat - 120) * 1000)).toEqual(Option.none());
  expect(await verify(await sign({ ...testClaims, exp: testClaims.iat + 301 }))).toEqual(
    Option.none(),
  );
  expect(await verify(await sign({ ...testClaims, exp: testClaims.iat + 300 }))).toEqual(
    Option.some("owner@just-be.dev"),
  );
});

test("a token for another key id is refused", async () => {
  expect(
    await verify(await sign(testClaims, { alg: "ES256", typ: "JWT", kid: "AAAAAAAAAAAAAAAA" })),
  ).toEqual(Option.none());
  expect(await verify(await sign(testClaims, { alg: "ES256", typ: "JWT" }))).toEqual(Option.none());
});

test("another algorithm is refused", async () => {
  const [, payload, signature] = testJwt.split(".");
  for (const alg of ["none", "RS256", "HS256", "ES384"]) {
    const header = base64Url(JSON.stringify({ alg, typ: "JWT", kid: testKid }));
    expect(await verify(`${header}.${payload}.${signature}`)).toEqual(Option.none());
    expect(await verify(`${header}.${payload}.`)).toEqual(Option.none());
  }
});

test("a tampered payload or signature is refused", async () => {
  const [header, , signature] = testJwt.split(".");
  const other = base64Url(
    JSON.stringify({ ...testClaims, email: "x@just-be.dev", sub: "x@just-be.dev" }),
  );
  expect(await verify(`${header}.${other}.${signature}`)).toEqual(Option.none());
  const flipped = `${signature?.slice(0, -2)}${signature?.endsWith("AA") ? "AB" : "AA"}`;
  expect(await verify(`${header}.${testJwt.split(".")[1]}.${flipped}`)).toEqual(Option.none());
});

test("claims that don't match are refused", async () => {
  for (const claims of [
    { ...testClaims, iss: "https://evil.example" },
    { ...testClaims, sub: "someone@just-be.dev" },
    { ...testClaims, email: "", sub: "" },
    { ...testClaims, aud: [testAudience] },
    { ...testClaims, exp: "1798761720" },
    { iss: testClaims.iss, aud: testAudience, iat: testClaims.iat, exp: testClaims.exp },
  ]) {
    expect(await verify(await sign(claims))).toEqual(Option.none());
  }
});

test("malformed tokens and keys are refused without failing", async () => {
  for (const token of [
    "",
    "a.b",
    "a.b.c",
    `${testJwt}.extra`,
    "é.é.é",
    testJwt.replace(".", ".."),
  ]) {
    expect(await verify(token)).toEqual(Option.none());
  }
  const broken = hubIdentityVerifier({ publicKeyPem: "nope", audience: testAudience });
  expect(await Effect.runPromise(broken(testJwt, testNow))).toEqual(Option.none());
});
