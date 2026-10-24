/**
 * The shared hub identity test vector (hub-frame-spike.md §4.4); the hub's and Desk's tests use the
 * same one. Its audience is Desk's spike preview; tests for this app's audience sign their own claims
 * with the same key.
 * TEST ONLY: this key must never be deployed.
 */
export const testPrivateKeyPem = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgm6/QgPr12UzeSS/k
gOdQuMdUu/TK9dwwrxTCjUYIem2hRANCAAQZxP5nqAD5O10H5s51z7nIlCmn6t4m
U3Phub3ucOZsZzMO68KH57+UIqkCTqZxo+LoXU/Pq+FepxIbAbsLT7FM
-----END PRIVATE KEY-----`;
export const testPublicKeyPem = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEGcT+Z6gA+TtdB+bOdc+5yJQpp+re
JlNz4bm97nDmbGczDuvCh+e/lCKpAk6mcaPi6F1Pz6vhXqcSGwG7C0+xTA==
-----END PUBLIC KEY-----`;
export const testKid = "OGLl9TdqVIB0gARS";
export const testJwt =
  "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6Ik9HTGw5VGRxVklCMGdBUlMifQ.eyJpc3MiOiJodHRwczovL2h1Yi5qdXN0LWJlLmRldiIsImF1ZCI6ImRlc2tAYi1zcGlrZS1odWItZnJhbWUtYTNjNGJkIiwic3ViIjoib3duZXJAanVzdC1iZS5kZXYiLCJlbWFpbCI6Im93bmVyQGp1c3QtYmUuZGV2IiwiaWF0IjoxNzk4NzYxNjAwLCJleHAiOjE3OTg3NjE3MjB9.TWL_0rxQwRF42a_Dr2HdE6j8gzL6e6kNumdRuFjwGJufttgOwa2Femt8CWH3YLZxvrSqPyRWcdwo3LvOqGrDLw";
export const testAudience = "desk@b-spike-hub-frame-a3c4bd";
export const testNow = 1798761650000;

const base64Url = (bytes: Uint8Array | string) =>
  btoa(typeof bytes === "string" ? bytes : String.fromCharCode(...bytes))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");

const pemDer = (pem: string) =>
  Uint8Array.from(atob(pem.replace(/-----[^-]+-----/gu, "").replace(/\s+/gu, "")), (char) =>
    char.charCodeAt(0),
  );

/** The shared vector's claims. */
export const testClaims = {
  iss: "https://hub.just-be.dev",
  aud: testAudience,
  sub: "owner@just-be.dev",
  email: "owner@just-be.dev",
  iat: 1798761600,
  exp: 1798761720,
};

/** Signs claims with the test key, as the hub would. */
export const signWithTestKey = async (
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "ES256", typ: "JWT", kid: testKid },
) => {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemDer(testPrivateKeyPem),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
};
