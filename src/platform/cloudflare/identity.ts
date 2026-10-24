import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { JWTVerifyGetKey } from "jose";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Principal } from "../../auth/identity.ts";
import { hubIdentityVerifier, type HubIdentityVerifier } from "./hub-identity.ts";

/**
 * Identity from Cloudflare Access.
 *
 * Requests that reach a Worker straight through Access carry `ctx.access`.
 * Requests to the API that arrive through the Website (over its service
 * binding) don't, and neither do Website requests themselves (the static
 * assets router sits in front of the edge script). Every request Access
 * admits carries a signed application token in `Cf-Access-Jwt-Assertion`,
 * which the edge forwards, so the API verifies that instead: RS256 against
 * the team's published keys, with the issuer and audience pinned.
 */

/** The Access application token header. */
export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

/** The claims or identity fields a principal is built from. */
export interface AccessClaims {
  readonly email?: unknown;
  readonly common_name?: unknown;
  readonly service_token_id?: unknown;
  readonly [key: string]: unknown;
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== "";

/**
 * The principal for a request Access admitted: a person when there's an
 * email, otherwise a service token (whose token has `common_name`, its client
 * id, and no email).
 */
export const principalFromAccess = (claims: AccessClaims | undefined): Principal => {
  if (nonEmpty(claims?.email)) {
    return { _tag: "User", email: claims.email };
  }
  const name = [claims?.common_name, claims?.service_token_id].find(nonEmpty);
  return { _tag: "ServiceToken", name: name ?? "service-token" };
};

/** `team.cloudflareaccess.com` or `https://team.cloudflareaccess.com/` → `https://team.cloudflareaccess.com`. */
export const teamIssuer = (teamDomain: string): string =>
  `https://${teamDomain
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")}`;

export interface AccessVerifier {
  readonly issuer: string;
  readonly audience: string;
  readonly keys: JWTVerifyGetKey;
}

/**
 * Fetches and caches the team's signing keys (Access rotates them every six
 * weeks). None when the team domain isn't a valid host, so nothing verifies.
 */
export const remoteVerifier = (
  teamDomain: string,
  audience: string,
): Option.Option<AccessVerifier> => {
  const issuer = teamIssuer(teamDomain);
  const certs = URL.parse(`${issuer}/cdn-cgi/access/certs`);
  return certs === null || audience === ""
    ? Option.none()
    : Option.some({ issuer, audience, keys: createRemoteJWKSet(certs) });
};

/** The principal in a valid Access application token; none for anything else. */
export const verifyAccessToken = (
  token: string | undefined,
  verifier: AccessVerifier,
): Effect.Effect<Option.Option<Principal>> =>
  token === undefined || token === ""
    ? Effect.succeed(Option.none())
    : Effect.tryPromise(() =>
        jwtVerify(token, verifier.keys, {
          issuer: verifier.issuer,
          audience: verifier.audience,
          algorithms: ["RS256"],
        }),
      ).pipe(
        Effect.map(({ payload }) => Option.some(principalFromAccess(payload))),
        Effect.orElseSucceed(() => Option.none<Principal>()),
      );

/**
 * How the API recognizes the hub that frames this app (hub-frame.ts): hub prod's service token,
 * by client id, and a verifier for the identity tokens it signs for this stage (hub-identity.ts).
 */
export interface HubTrust {
  readonly clientId: string;
  readonly verifyIdentity: HubIdentityVerifier;
}

/**
 * The hub trust from the API's `HUB_CLIENT_ID`, `HUB_PUBLIC_KEY` and `HUB_AUDIENCE`; none when any
 * is missing or blank (`alchemy dev` binds none), so the hub is never recognized there.
 */
export const hubTrustFrom = (env: Readonly<Record<string, unknown>>): Option.Option<HubTrust> => {
  const [clientId, publicKeyPem, audience] = [
    env["HUB_CLIENT_ID"],
    env["HUB_PUBLIC_KEY"],
    env["HUB_AUDIENCE"],
  ].map((value) => (typeof value === "string" ? value.trim() : ""));
  return clientId === undefined ||
    publicKeyPem === undefined ||
    audience === undefined ||
    clientId === "" ||
    publicKeyPem === "" ||
    audience === ""
    ? Option.none()
    : Option.some({ clientId, verifyIdentity: hubIdentityVerifier({ publicKeyPem, audience }) });
};

/** What a request carries that names who sent it. */
export interface RequestCredentials {
  /**
   * When the request came straight through Access (`ctx.access`, set by Cloudflare's edge): the
   * email its identity names, if any. None for requests from the Website's service binding.
   */
  readonly access: Option.Option<{ readonly email: unknown }>;
  /** `Cf-Access-Jwt-Assertion`. */
  readonly jwt: string | undefined;
  /** The hub's `x-hub-identity`. */
  readonly hubIdentity: string | undefined;
}

// NOTE: Access admits hub prod's PlatformToken (access.ts) so the hub can proxy people's requests,
// but the token itself is no one: a framed preview's code may hold its secret (hub-frame-spike.md
// R4). So a principal that is the hub's token never stands for itself. It becomes the person the
// hub's signed identity token names for this stage, or no one. Because `ctx.access` alone no
// longer tells service tokens apart, a service token is named only by its verified JWT, even on
// requests straight through Access; a person's own Access identity always wins.
/**
 * The request's principal: a person Access signed in, a service token named by its verified Access
 * JWT, or the person the trusted hub vouches for. None for anything else.
 */
export const requestPrincipal = Effect.fn("Identity.requestPrincipal")(function* (
  credentials: RequestCredentials,
  verifier: Option.Option<AccessVerifier>,
  hub: Option.Option<HubTrust>,
  nowMillis: number,
) {
  if (Option.isSome(credentials.access) && nonEmpty(credentials.access.value.email)) {
    return Option.some<Principal>({ _tag: "User", email: credentials.access.value.email });
  }
  const verified = Option.isNone(verifier)
    ? Option.none<Principal>()
    : yield* verifyAccessToken(credentials.jwt, verifier.value);
  if (
    Option.isNone(verified) ||
    verified.value._tag !== "ServiceToken" ||
    Option.isNone(hub) ||
    verified.value.name !== hub.value.clientId
  ) {
    return verified;
  }
  if (credentials.hubIdentity === undefined) {
    return Option.none<Principal>();
  }
  const email = yield* hub.value.verifyIdentity(credentials.hubIdentity, nowMillis);
  return Option.map(email, (address): Principal => ({ _tag: "User", email: address }));
});
