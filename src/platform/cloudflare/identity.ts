import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { JWTVerifyGetKey } from "jose";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Principal } from "../../auth/identity.ts";

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
