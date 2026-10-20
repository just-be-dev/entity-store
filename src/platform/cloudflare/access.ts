import * as user from "@distilled.cloud/cloudflare/user";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

/**
 * Cloudflare Access in front of both Workers (Website and API), so every
 * entry point (custom routes, `workers.dev`, version preview URLs) needs a
 * login. Two ways in:
 *
 * - the Cloudflare user who deploys the stack, via Access login with the
 *   same email as their Cloudflare login;
 * - the `AgentToken` service token (`CF-Access-Client-Id` /
 *   `CF-Access-Client-Secret` headers), for automated testing. Its secret
 *   lives only in Alchemy state.
 *
 * Nothing is configured by hand: the email and the Zero Trust team domain are
 * looked up from the Cloudflare API at plan time. The API checks identity
 * itself as well (see identity.ts). Local dev (`alchemy dev`) creates no
 * Access resources; the API simulates a signed-in dev user instead.
 */

/** True under `alchemy dev`. Read when the stack module loads, like DeployConfig. */
export const isDev = Effect.runSync(Alchemy.ALCHEMY_DEV);

/**
 * Plan time only: the deploying user's email and the account's Zero Trust
 * team domain (the issuer of the Access tokens the API verifies). Fails the
 * plan with a readable reason if either is unavailable.
 */
export const deployer = Effect.gen(function* () {
  const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
  const me = yield* user.getUser({});
  const org = yield* zeroTrust.listOrganizationsForAccount({ accountId });
  if (!me.email) {
    return yield* Effect.die(
      new Error("Couldn't read your Cloudflare email; the deploy token needs User Details: Read"),
    );
  }
  if (!org.authDomain) {
    return yield* Effect.die(
      new Error("This Cloudflare account has no Zero Trust organization; set up a team domain"),
    );
  }
  return { email: me.email, teamDomain: org.authDomain };
}).pipe(
  Effect.catchTag("OrganizationNotFound", () =>
    Effect.die(
      new Error("This Cloudflare account has no Zero Trust organization; set up a team domain"),
    ),
  ),
  // A failed lookup can only abort the plan; say what was being looked up.
  Effect.catch((error) =>
    Effect.die(new Error("Couldn't look up the deploying Cloudflare user", { cause: error })),
  ),
);

/** For automated clients (an agent). Rotate by bumping `clientSecretVersion`. */
export const AgentToken = Cloudflare.Access.ServiceToken("AgentToken", { duration: "8760h" });

/** One application, shared by both Workers, so a login covers the whole app. */
export const AccessApp = Cloudflare.Access.Application(
  "Access",
  Effect.gen(function* () {
    const { email } = yield* deployer;
    const token = yield* AgentToken;
    return {
      type: "self_hosted" as const,
      sessionDuration: "24h",
      policies: [
        { name: "Owner", decision: "allow" as const, include: [{ email }] },
        {
          name: "Agent token",
          decision: "non_identity" as const,
          include: [{ serviceToken: token.serviceTokenId }],
        },
      ],
    };
  }),
);

/** The identity `alchemy dev` simulates for the API, since there's no Access locally. */
export const DEV_IDENTITY = { email: "dev@localhost" };
