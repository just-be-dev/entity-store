import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

/**
 * Cloudflare Access in front of both Workers (Website and API), so every
 * entry point (custom routes, `workers.dev`, version preview URLs) needs a
 * login. Two ways in:
 *
 * - members of the Cloudflare account, via Access login;
 * - the `AgentToken` service token (`CF-Access-Client-Id` /
 *   `CF-Access-Client-Secret` headers), for automated testing. Its secret
 *   lives only in Alchemy state.
 *
 * Nothing is configured by hand: Access checks account membership itself, and
 * the Zero Trust team domain is looked up from the Cloudflare API at plan
 * time. Nothing asks who is deploying, so account-owned deploy tokens (such as
 * a CI runner's) work. The API checks identity itself as well (see
 * identity.ts). Local dev (`alchemy dev`) creates no Access resources; the API
 * simulates a signed-in dev user instead.
 */

/** True under `alchemy dev`. Read when the stack module loads, like DeployConfig. */
export const isDev = Effect.runSync(Alchemy.ALCHEMY_DEV);

/**
 * Plan time only: the account's Zero Trust team domain (the issuer of the
 * Access tokens the API verifies). Fails the plan with a readable reason if
 * it is unavailable.
 */
export const teamDomain = Effect.gen(function* () {
  const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
  const org = yield* zeroTrust.listOrganizationsForAccount({ accountId });
  if (!org.authDomain) {
    return yield* Effect.die(
      new Error("This Cloudflare account has no Zero Trust organization; set up a team domain"),
    );
  }
  return org.authDomain;
}).pipe(
  Effect.catchTag("OrganizationNotFound", () =>
    Effect.die(
      new Error("This Cloudflare account has no Zero Trust organization; set up a team domain"),
    ),
  ),
  // A failed lookup can only abort the plan; say what was being looked up.
  Effect.catch((error) =>
    Effect.die(new Error("Couldn't look up the Zero Trust team domain", { cause: error })),
  ),
);

/** For automated clients (an agent). Rotate by bumping `clientSecretVersion`. */
export const AgentToken = Cloudflare.Access.ServiceToken("AgentToken", { duration: "8760h" });

/** One application, shared by both Workers, so a login covers the whole app. */
export const AccessApp = Cloudflare.Access.Application(
  "Access",
  Effect.gen(function* () {
    const token = yield* AgentToken;
    return {
      type: "self_hosted" as const,
      sessionDuration: "24h",
      policies: [
        {
          name: "Account members",
          decision: "allow" as const,
          include: [{ cloudflareAccountMember: token.accountId }],
        },
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
