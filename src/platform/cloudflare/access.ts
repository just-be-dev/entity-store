import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

/**
 * Cloudflare Access in front of both Workers (Website and API), so every
 * entry point (custom routes, `workers.dev`, version preview URLs) needs a
 * login. Two ways in:
 *
 * - people listed in `ACCESS_EMAILS` (comma-separated), via Access login;
 * - the `AgentToken` service token (`CF-Access-Client-Id` /
 *   `CF-Access-Client-Secret` headers), for automated testing.
 *
 * The API checks identity itself as well (see identity.ts). Local dev
 * (`alchemy dev`) creates no Access resources; the API simulates a signed-in
 * dev user instead.
 */

/** True under `alchemy dev`. Read when the stack module loads, like DeployConfig. */
export const isDev = Effect.runSync(Alchemy.ALCHEMY_DEV);

/** Who may sign in. Required to deploy; read at plan time. */
export const AccessEmails = Config.String("ACCESS_EMAILS").pipe(
  Config.map((value) =>
    value
      .split(",")
      .map((email) => email.trim())
      .filter((email) => email.length > 0),
  ),
);

/** For automated clients (an agent). Rotate by bumping `clientSecretVersion`. */
export const AgentToken = Cloudflare.Access.ServiceToken("AgentToken", { duration: "8760h" });

/** One application, shared by both Workers, so a login covers the whole app. */
export const AccessApp = Cloudflare.Access.Application(
  "Access",
  Effect.gen(function* () {
    const emails: ReadonlyArray<string> = yield* AccessEmails.pipe(
      Effect.filterOrFail(
        (list) => list.length > 0,
        () => new Error("ACCESS_EMAILS is empty"),
      ),
      Effect.orDie,
    );
    const token = yield* AgentToken;
    return {
      type: "self_hosted" as const,
      sessionDuration: "24h",
      policies: [
        { name: "People", decision: "allow" as const, include: emails.map((email) => ({ email })) },
        {
          name: "Agent token",
          decision: "non_identity" as const,
          include: [{ serviceToken: token.serviceTokenId }],
        },
      ],
    };
  }),
);

/**
 * The Zero Trust team domain, e.g. `team.cloudflareaccess.com`: the issuer of
 * Access tokens the API verifies. Required to deploy; read at plan time.
 */
export const AccessTeamDomain = Config.String("ACCESS_TEAM_DOMAIN");

/** The identity `alchemy dev` simulates for the API, since there's no Access locally. */
export const DEV_IDENTITY = { email: "dev@localhost" };
