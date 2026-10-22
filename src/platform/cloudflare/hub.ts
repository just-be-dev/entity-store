/**
 * The hub shell: the platform's app rail and assistant, served by the agents project (stack `cfp`,
 * docs/hub-shell.md there) and loaded on this app's page from `/_hub/shell.js`. The App
 * Worker forwards `/_hub/*` to agents' `Embed` Worker, and `/_hub/api/*` to agents' API over RPC
 * (`platformFetch`) with the email Access admitted, so the assistant acts for the same person.
 *
 * Every deployed stage binds agents' prod, which owns the assistant; `alchemy dev` binds nothing
 * and the page simply has no shell.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import type * as Effect from "effect/Effect";

const AGENTS_STACK = "cfp";
const AGENTS_STAGE = "prod";

/** The App's bindings to agents' Workers, by typed ref (another stack's state). */
export const hubBindings = (
  dev: boolean,
): Readonly<Record<string, Effect.Effect<Cloudflare.Worker>>> =>
  dev
    ? {}
    : {
        HUB_API: Cloudflare.Worker.ref("Api", { stack: AGENTS_STACK, stage: AGENTS_STAGE }),
        HUB_EMBED: Cloudflare.Worker.ref("Embed", { stack: AGENTS_STACK, stage: AGENTS_STAGE }),
      };

/** The paths the App Worker runs first for the shell. */
export const hubPaths = ["/_hub", "/_hub/*"];

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

/**
 * Forwards a shell request to agents. Only call it for {@link isHubPath} URLs. `email` is the
 * person the assistant acts for; by default the one Access admitted (it sets this header on
 * every request it lets through, and a service token has none, which the assistant refuses).
 */
export const forwardToHub = (
  request: Request,
  url: URL,
  env: Readonly<Record<string, unknown>>,
  email: string | null = request.headers.get("cf-access-authenticated-user-email"),
): Promise<Response> => {
  if (url.pathname.startsWith(HUB_API)) {
    const api = env["HUB_API"];
    if (!isPlatformApi(api)) return Promise.resolve(unbound());
    // The API's own path: the prefix dropped, the query kept.
    const forwarded = `${url.origin}${url.pathname.slice(HUB.length)}${url.search}`;
    return api.platformFetch(new Request(forwarded, request), email);
  }
  const embed = env["HUB_EMBED"];
  return isFetcher(embed) ? embed.fetch(request) : Promise.resolve(unbound());
};
