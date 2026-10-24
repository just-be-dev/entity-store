/**
 * The hub's identity token (`x-hub-identity`): who the hub at hub.just-be.dev vouches for when it
 * frames this app and proxies its requests. A short-lived ES256 JWS signed by hub prod's
 * `IdentityKey`, scoped to `entities@<stage>`. The API takes an email from it only when the request
 * also carries hub prod's service-token JWT (identity.ts); this module checks the token itself.
 * Contract: hub-frame-spike.md §4.4. Copied from Desk's verifier; keep the two in step.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The hub sends its identity token in this request header. */
export const hubIdentityHeader = "x-hub-identity";

/** The issuer every hub stage names. */
export const hubIssuer = "https://hub.just-be.dev";

/** What a hub identity token must match: the trusted hub's public key, and this stage's audience. */
export type HubIdentityCheck = Readonly<{
  /** The hub's `IdentityKey` public key, PEM spki. */
  publicKeyPem: string;
  /** `entities@<stage>` for this stage. */
  audience: string;
}>;

const Header = Schema.Struct({ alg: Schema.String, kid: Schema.String });

const Claims = Schema.Struct({
  iss: Schema.String,
  aud: Schema.String,
  sub: Schema.String,
  email: Schema.String,
  iat: Schema.Finite,
  exp: Schema.Finite,
});
type Claims = typeof Claims.Type;

const fromBase64 = (base64: string): Uint8Array<ArrayBuffer> | null => {
  try {
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
};

const fromBase64Url = (part: string): Uint8Array<ArrayBuffer> | null =>
  /^[A-Za-z0-9_-]*$/u.test(part) ? fromBase64(part.replace(/-/gu, "+").replace(/_/gu, "/")) : null;

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");

const decodeJson = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  part: string,
): Option.Option<S["Type"]> => {
  const bytes = fromBase64Url(part);
  return bytes === null
    ? Option.none()
    : Schema.decodeUnknownOption(Schema.fromJsonString(schema))(new TextDecoder().decode(bytes));
};

/** The DER bytes of a PEM `PUBLIC KEY` block, or null when it isn't one. */
const spkiDer = (pem: string): Uint8Array<ArrayBuffer> | null => {
  const match = /-----BEGIN PUBLIC KEY-----([\s\S]+?)-----END PUBLIC KEY-----/u.exec(pem);
  return match?.[1] === undefined ? null : fromBase64(match[1].replace(/\s+/gu, ""));
};

/** The key id both sides derive from the public key: base64url(SHA-256(SPKI DER)), first 16 chars. */
export const kidOf = (publicKeyPem: string): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const der = spkiDer(publicKeyPem);
    if (der === null) return Option.none();
    return yield* Effect.tryPromise(() => crypto.subtle.digest("SHA-256", der)).pipe(
      Effect.map((digest) => Option.some(toBase64Url(new Uint8Array(digest)).slice(0, 16))),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
  });

type VerifyingKey = Readonly<{ key: CryptoKey; kid: string }>;

const importVerifyingKey = (publicKeyPem: string): Effect.Effect<Option.Option<VerifyingKey>> =>
  Effect.gen(function* () {
    const der = spkiDer(publicKeyPem);
    const kid = yield* kidOf(publicKeyPem);
    if (der === null || Option.isNone(kid)) return Option.none();
    return yield* Effect.tryPromise(() =>
      crypto.subtle.importKey("spki", der, { name: "ECDSA", namedCurve: "P-256" }, false, [
        "verify",
      ]),
    ).pipe(
      Effect.map((key) => Option.some({ key, kid: kid.value })),
      Effect.orElseSucceed(() => Option.none<VerifyingKey>()),
    );
  });

// NOTE: A minute of clock skew, as Desk allows; the hub's tokens live 120 s, and no token may claim
// more than five minutes.
const leewaySeconds = 60;
const maxLifetimeSeconds = 300;

const claimsAccepted = (claims: Claims, audience: string, nowSeconds: number): boolean =>
  claims.iss === hubIssuer &&
  claims.aud === audience &&
  claims.email !== "" &&
  claims.email === claims.sub &&
  claims.exp + leewaySeconds > nowSeconds &&
  claims.iat - leewaySeconds <= nowSeconds &&
  claims.exp - claims.iat <= maxLifetimeSeconds;

/** Checks a token against the key and audience; the email it names, or none on any failure. */
const verifyWith = (
  token: string,
  audience: string,
  key: VerifyingKey,
  nowMillis: number,
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const parts = token.split(".");
    if (parts.length !== 3) return Option.none();
    const [headerPart = "", payloadPart = "", signaturePart = ""] = parts;
    const header = decodeJson(Header, headerPart);
    const claims = decodeJson(Claims, payloadPart);
    const signature = fromBase64Url(signaturePart);
    if (Option.isNone(header) || Option.isNone(claims) || signature === null) return Option.none();
    if (header.value.alg !== "ES256" || header.value.kid !== key.kid) return Option.none();
    if (!claimsAccepted(claims.value, audience, Math.floor(nowMillis / 1000))) return Option.none();
    const verified = yield* Effect.tryPromise(() =>
      crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key.key,
        signature,
        new TextEncoder().encode(`${headerPart}.${payloadPart}`),
      ),
    ).pipe(Effect.orElseSucceed(() => false));
    return verified ? Option.some(claims.value.email) : Option.none();
  });

/** Verifies a hub identity token at `nowMillis`: the email it vouches for, or none. */
export type HubIdentityVerifier = (
  token: string,
  nowMillis: number,
) => Effect.Effect<Option.Option<string>>;

/**
 * A verifier for one hub stage's key and this stage's audience. The key is imported on first use
 * and kept for the isolate's lifetime. Any failure, including a key that doesn't import, is none;
 * it never fails or throws.
 */
export const hubIdentityVerifier = (check: HubIdentityCheck): HubIdentityVerifier => {
  let imported: Option.Option<VerifyingKey> | undefined;
  const key = Effect.suspend(() =>
    imported === undefined
      ? importVerifyingKey(check.publicKeyPem).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              imported = result;
            }),
          ),
        )
      : Effect.succeed(imported),
  );
  return (token, nowMillis) =>
    key.pipe(
      Effect.flatMap((maybeKey) =>
        Option.match(maybeKey, {
          onNone: () => Effect.succeed(Option.none<string>()),
          onSome: (verifying) => verifyWith(token, check.audience, verifying, nowMillis),
        }),
      ),
    );
};
