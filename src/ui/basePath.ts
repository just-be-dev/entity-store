import { UrlRequest } from "foldkit/navigation";
import { type Url, toString as urlToString } from "foldkit/url";

/**
 * Entities runs at `/` on its own host, and under a base path when the hub frames it (`/entities/`
 * or `/entities@<stage>/` on hub.just-be.dev). One build serves both: the hub injects
 * `<base href="/entities@…/">` ahead of the app's own `<base href="/">`, and the app reads it at
 * runtime. Routes see paths without the base (`stripBase`, `stripUrl`); every URL the app hands the
 * browser (history, fetch, links, the hub's nav) goes through `withBase`.
 */

/** The path the app is served under: the first `<base>`'s pathname, always ending in `/`. */
export const appBase = (): string => {
  if (typeof document === "undefined") {
    return "/";
  }
  const baseHref = document.querySelector("base")?.href;
  const pathname = baseHref === undefined ? "/" : (URL.parse(baseHref)?.pathname ?? "/");
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
};

/** The base without its trailing slash: `/entities@x` for `/entities@x/`, `""` for `/`. */
const baseRoot = (base: string): string => base.slice(0, -1);

/** Whether a browser pathname belongs to the app served at `base`. */
export const isUnderBase = (base: string, pathname: string): boolean =>
  base === "/" || pathname === baseRoot(base) || pathname.startsWith(base);

/** The app's own path for a browser pathname: `/entities@x/types` → `/types`, `/entities@x` → `/`. */
export const stripBase = (base: string, pathname: string): string => {
  if (base === "/") {
    return pathname;
  }
  if (pathname === baseRoot(base) || pathname === base) {
    return "/";
  }
  return pathname.startsWith(base) ? pathname.slice(base.length - 1) : pathname;
};

// NOTE: Not idempotent, unlike Desk's: prod's base is `/entities/`, the same word as the app's own
// `/entities/<id>` route, so a path that already looks based may be an app path. Pass only the
// app's own paths (routes, API paths), never a URL read back from the browser.
/**
 * The browser's URL for one of the app's own: a root-relative path gets the base in front, and so
 * does a full URL on `origin`, which keeps its origin. Other origins and relative URLs are unchanged.
 */
export const withBase = (base: string, href: string, origin: string): string => {
  if (base === "/") {
    return href;
  }
  if (href.startsWith("/") && !href.startsWith("//")) {
    return `${base}${href.slice(1)}`;
  }
  const url = URL.parse(href);
  if (url === null || url.origin !== origin || !/^https?:$/u.test(url.protocol)) {
    return href;
  }
  return `${url.origin}${withBase(base, `${url.pathname}${url.search}${url.hash}`, origin)}`;
};

/** {@link withBase} for this page's base and origin. */
export const withAppBase = (href: string): string => {
  const base = appBase();
  return base === "/" ? href : withBase(base, href, window.location.origin);
};

/** A Foldkit `Url` as the app's routes see it: its pathname without the base. */
export const stripUrl = (url: Url, base: string = appBase()): Url => ({
  ...url,
  pathname: stripBase(base, url.pathname),
});

// NOTE: Under the hub, links to the other apps (`/desk/…`) are on this page's origin, so Foldkit
// reports them as Internal; they aren't this app's routes, so they load as a document instead.
/** A link click as the app should follow it: same-origin paths outside the base load in full. */
export const followWithinBase = (request: UrlRequest, base: string = appBase()): UrlRequest =>
  UrlRequest.match(request, {
    Internal: ({ url }) =>
      isUnderBase(base, url.pathname) ? request : UrlRequest.External({ href: urlToString(url) }),
    External: () => request,
  });
