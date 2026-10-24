/**
 * Sends a person who opens this app on its own hostname to the hub, so shared and bookmarked links
 * land in the platform's one page (hub-frame-rollout.md §1.6): a top-level page load of
 * `entity-store.just-be.dev/types/person?x` becomes `hub.just-be.dev/entities/types/person?x`, and
 * on a preview `hub.just-be.dev/entities@<stage>/…`. The hub frames the same path back from here.
 *
 * The edge loads this at runtime: no Alchemy here (hub.test.ts checks). The stack binds the
 * stage's prefix (`HUB_FRAME_PREFIX`, hub-frame.ts) and hub prod's client id (`HUB_CLIENT_ID`) on
 * deployed stages only; without both, as under `alchemy dev`, nothing redirects.
 */
import * as Option from "effect/Option";
import { ACCESS_JWT_HEADER } from "./identity.ts";

/** The hub every stage sends people to (hub-frame.ts trusts hub prod). */
export const HUB_ORIGIN = "https://hub.just-be.dev";

/** What the redirect needs from the App's env. */
export interface HubRedirectConfig {
  /** `/entities` on prod, `/entities@<stage>` on a preview. */
  readonly prefix: string;
  /** Hub prod's service token, whose requests are the hub framing the app. */
  readonly hubClientId: string;
}

/** The config from the App's `HUB_FRAME_PREFIX` and `HUB_CLIENT_ID`; none when either is blank. */
export const hubRedirectConfig = (
  env: Readonly<Record<string, unknown>>,
): Option.Option<HubRedirectConfig> => {
  const prefix = env["HUB_FRAME_PREFIX"];
  const hubClientId = env["HUB_CLIENT_ID"];
  return typeof prefix === "string" &&
    typeof hubClientId === "string" &&
    prefix.startsWith("/") &&
    hubClientId.trim() !== ""
    ? Option.some({ prefix, hubClientId: hubClientId.trim() })
    : Option.none();
};

/** Paths that are never pages: the API, the shell, and Cloudflare's and the web's well-known paths. */
const nonPageSegments = ["api", "_hub", ".well-known", "cdn-cgi"];

/** The app's own routes whose last segment is a name or id that may hold a dot. */
const pageRoutePrefixes = ["/types/", "/entities/"];

const hasExtension = (pathname: string): boolean =>
  /\.[A-Za-z0-9]+$/u.test(pathname.slice(pathname.lastIndexOf("/") + 1));

const isNonPage = (pathname: string): boolean => {
  // `/mcp*`: any path starting so, `/mcp`, `/mcp/…` and `/mcpx` alike.
  if (pathname.startsWith("/mcp")) return true;
  const first = pathname.split("/")[1] ?? "";
  if (nonPageSegments.includes(first)) return true;
  return hasExtension(pathname) && !pageRoutePrefixes.some((prefix) => pathname.startsWith(prefix));
};

const decodeBase64Url = (part: string): string | null => {
  try {
    const base64 = part.replace(/-/gu, "+").replace(/_/gu, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
};

// NOTE: Access already admitted the request and the API verifies the JWT itself; this only asks
// whether it's the hub's, so a forged one gains nothing but the page it would have got anyway.
/** Whether the request's Access JWT names the hub's service token (decoded, not verified). */
const isFromHub = (request: Request, hubClientId: string): boolean => {
  const payload = request.headers.get(ACCESS_JWT_HEADER)?.split(".")[1];
  const json = payload === undefined ? null : decodeBase64Url(payload);
  if (json === null) return false;
  try {
    const claims: unknown = JSON.parse(json);
    return (
      typeof claims === "object" &&
      claims !== null &&
      "common_name" in claims &&
      claims.common_name === hubClientId
    );
  } catch {
    return false;
  }
};

/**
 * Where to send this request on the hub, or none: only a person's top-level page load (`GET` or
 * `HEAD`, `Sec-Fetch-Dest: document`, `Sec-Fetch-Mode: navigate`) of a page path, and never the
 * hub's own proxied requests.
 */
export const hubRedirect = (
  request: Request,
  url: URL,
  config: Option.Option<HubRedirectConfig>,
): Option.Option<string> => {
  if (Option.isNone(config)) return Option.none();
  if (request.method !== "GET" && request.method !== "HEAD") return Option.none();
  if (request.headers.get("sec-fetch-dest") !== "document") return Option.none();
  if (request.headers.get("sec-fetch-mode") !== "navigate") return Option.none();
  if (isNonPage(url.pathname)) return Option.none();
  if (isFromHub(request, config.value.hubClientId)) return Option.none();
  return Option.some(`${HUB_ORIGIN}${config.value.prefix}${url.pathname}${url.search}`);
};

/** The redirect itself: a 302 nothing caches. */
export const redirectTo = (location: string): Response =>
  new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
