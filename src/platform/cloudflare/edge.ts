import * as Option from "effect/Option";
import { forwardToHub, isHubPath } from "./hub.ts";
import { hubRedirect, hubRedirectConfig, redirectTo } from "./hub-redirect.ts";

/**
 * What the edge reads from the App's env (`AppEnv`, checked in hub.test.ts): the API, and
 * agents' bindings and the Access settings for the shell (hub.ts), and the redirect to the hub
 * (hub-redirect.ts). `ASSETS`, the built UI, is the Website's own binding.
 */
export type EdgeEnv = Readonly<Record<string, unknown>> &
  Readonly<{ API: { readonly fetch: (request: Request) => Promise<Response> } }>;

interface Fetcher {
  readonly fetch: (request: Request) => Promise<Response>;
}

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" &&
  value !== null &&
  "fetch" in value &&
  typeof value.fetch === "function";

/** The headers `public/_headers` sets on every asset (hub.test.ts keeps the two in step). */
export const assetHeaders: Readonly<Record<string, string>> = {
  "content-security-policy":
    "default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self'; frame-src 'self'",
  "x-content-type-options": "nosniff",
};

// NOTE: Cloudflare doesn't promise that `_headers` applies to responses a Worker returns, even
// from `ASSETS.fetch`, so the edge sets any of its headers that are missing.
/** An asset from the build, with `_headers`' policy whether or not Cloudflare applied it. */
const serveAsset = async (assets: Fetcher, request: Request): Promise<Response> => {
  const response = await assets.fetch(request);
  const missing = Object.entries(assetHeaders).filter(([name]) => !response.headers.has(name));
  if (missing.length === 0) return response;
  const served = new Response(response.body, response);
  for (const [name, value] of missing) served.headers.set(name, value);
  return served;
};

const isApiPath = (url: URL) => url.pathname === "/api" || url.pathname.startsWith("/api/");

export default {
  fetch(request: Request, env: EdgeEnv): Promise<Response> {
    const url = URL.parse(request.url);
    // The hub shell's `/_hub/*` goes to the agents project (hub.ts).
    if (url !== null && isHubPath(url)) return forwardToHub(request, url, env);
    // Headers, including the Access token the API verifies, pass through unchanged.
    if (url === null || isApiPath(url)) return env.API.fetch(request);
    // Deployed stages run the edge first for pages too, to send people to the hub.
    const target = hubRedirect(request, url, hubRedirectConfig(env));
    if (Option.isSome(target)) return Promise.resolve(redirectTo(target.value));
    const assets = env["ASSETS"];
    return isFetcher(assets) ? serveAsset(assets, request) : env.API.fetch(request);
  },
};
