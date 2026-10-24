/**
 * The hub shell: the platform's app rail and assistant, served by the agents project (stack `cfp`,
 * docs/hub-shell.md there) and loaded on this app's page from `/_hub/shell.js`. The App
 * Worker forwards `/_hub/*` to agents' `Embed` Worker, and `/_hub/api/*` to agents' API over RPC
 * (`platformFetch`) with the email Access admitted, so the assistant acts for the same person.
 *
 * `index.html` also loads `/_hub/boot.js` synchronously in `<head>`, which reserves the sidebar before first paint.
 *
 * Every deployed stage binds agents' prod, which owns the assistant (hub-bindings.ts); `alchemy
 * dev` binds nothing and the page simply has no shell.
 */
// NOTE: The edge imports this module at runtime, so it must not import Alchemy (or anything that
// does): its bindings live in hub-bindings.ts, which only the stack imports. hub.test.ts checks.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { AccessVerifier } from "./identity.ts";
import { ACCESS_JWT_HEADER, remoteVerifier, verifyAccessToken } from "./identity.ts";

/** The paths the App Worker runs first for the shell. */
export const hubPaths = ["/_hub", "/_hub/*"];

/** The email header Access sets for a person it signed in. */
export const ACCESS_EMAIL_HEADER = "cf-access-authenticated-user-email";

const HUB = "/_hub";
const HUB_API = `${HUB}/api/`;

interface Fetcher {
  readonly fetch: (request: Request) => Promise<Response>;
}
interface PlatformApi {
  readonly platformFetch: (request: Request, email: string | null) => Promise<Response>;
}

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" &&
  value !== null &&
  "fetch" in value &&
  typeof value.fetch === "function";

const isPlatformApi = (value: unknown): value is PlatformApi =>
  typeof value === "object" &&
  value !== null &&
  "platformFetch" in value &&
  typeof value.platformFetch === "function";

const unbound = () => new Response("The hub shell isn't available here.", { status: 404 });

/** Whether `url` is the shell's. */
export const isHubPath = (url: URL) => url.pathname === HUB || url.pathname.startsWith(`${HUB}/`);

// NOTE: The App's Access application also admits the AgentToken service token, whose JWT names no
// person; an email header sent beside it is the client's own, not Access's. So the header counts
// only when Access's JWT, verified (signature, issuer, audience, expiry), names the same person.
/**
 * The person Access admitted: the email in the request's verified Access JWT, when the email
 * header names the same person. Null for a service token, a forged or mismatched header, an
 * invalid or missing JWT, or no verifier.
 */
export const admittedEmail = Effect.fn("Hub.admittedEmail")(function* (
  request: Request,
  verifier: Option.Option<AccessVerifier>,
) {
  const header = request.headers.get(ACCESS_EMAIL_HEADER)?.trim() ?? "";
  if (header === "" || Option.isNone(verifier)) return null;
  const principal = yield* verifyAccessToken(
    request.headers.get(ACCESS_JWT_HEADER) ?? undefined,
    verifier.value,
  );
  return Option.match(principal, {
    onNone: () => null,
    onSome: (verified) =>
      verified._tag === "User" && verified.email.toLowerCase() === header.toLowerCase()
        ? verified.email
        : null,
  });
});

// The verifier caches the team's signing keys, so keep one per isolate (per env settings).
let cachedVerifier: { readonly key: string; readonly verifier: Option.Option<AccessVerifier> } = {
  key: "",
  verifier: Option.none(),
};

/** The Access verifier for the App's `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`; none without them. */
export const hubVerifier = (
  env: Readonly<Record<string, unknown>>,
): Option.Option<AccessVerifier> => {
  const teamDomain = env["ACCESS_TEAM_DOMAIN"];
  const audience = env["ACCESS_AUD"];
  if (typeof teamDomain !== "string" || typeof audience !== "string") return Option.none();
  const key = `${teamDomain}\n${audience}`;
  if (cachedVerifier.key !== key) {
    cachedVerifier = { key, verifier: remoteVerifier(teamDomain, audience) };
  }
  return cachedVerifier.verifier;
};

/**
 * Forwards a shell request to agents. Only call it for {@link isHubPath} URLs. API calls carry
 * the person the assistant acts for: the one Access admitted ({@link admittedEmail}), or null,
 * which the assistant refuses.
 */
export const forwardToHub = async (
  request: Request,
  url: URL,
  env: Readonly<Record<string, unknown>>,
  verifier: Option.Option<AccessVerifier> = hubVerifier(env),
): Promise<Response> => {
  if (url.pathname.startsWith(HUB_API)) {
    const api = env["HUB_API"];
    if (!isPlatformApi(api)) return unbound();
    const email = await Effect.runPromise(admittedEmail(request, verifier));
    // The API's own path: the prefix dropped, the query kept.
    const forwarded = `${url.origin}${url.pathname.slice(HUB.length)}${url.search}`;
    return api.platformFetch(new Request(forwarded, request), email);
  }
  const embed = env["HUB_EMBED"];
  return isFetcher(embed) ? embed.fetch(request) : unbound();
};
