import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Schema from "effect/Schema";
import * as String from "effect/String";
import * as Route from "foldkit/route";
import { defineRouteUnion, literal, param, slash, string } from "foldkit/route";
import { modifyFields } from "foldkit/struct";
import type { Url } from "foldkit/url";

export const AppRoute = defineRouteUnion({
  TypeList: {},
  TypeDetail: { name: Schema.String },
  NewVersion: { name: Schema.String },
  TypeIndexes: { name: Schema.String },
  EntityDetail: { id: Schema.String },
  NotFound: { path: Schema.String },
});
export type AppRoute = typeof AppRoute.Type;

export const typeListRouter = pipe(Route.root, Route.mapTo(AppRoute.TypeList));

export const typeDetailRouter = pipe(
  literal("types"),
  slash(string("name")),
  Route.mapTo(AppRoute.TypeDetail),
);

export const newVersionRouter = pipe(
  literal("types"),
  slash(string("name")),
  slash(literal("versions")),
  slash(literal("new")),
  Route.mapTo(AppRoute.NewVersion),
);

export const typeIndexesRouter = pipe(
  literal("types"),
  slash(string("name")),
  slash(literal("indexes")),
  Route.mapTo(AppRoute.TypeIndexes),
);

const decodeSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/**
 * An entity id segment. Ids may hold `@` and `.`, and links from other
 * apps encode them (`ada%40example.com`), so the segment is decoded on
 * parse and encoded on print.
 */
const entityIdParam = param(
  "entity id",
  (segment) => Effect.succeed({ id: decodeSegment(segment) }),
  (value: { readonly id: string }) => encodeURIComponent(value.id),
);

export const entityDetailRouter = pipe(
  literal("entities"),
  slash(entityIdParam),
  Route.mapTo(AppRoute.EntityDetail),
);

const routeParser = Route.oneOf(
  newVersionRouter,
  typeIndexesRouter,
  typeDetailRouter,
  entityDetailRouter,
  typeListRouter,
);

const parseRoute = Route.parseUrlWithFallback(routeParser, AppRoute.NotFound);

/** `/cafe/` → `/cafe`, `/` → ``. */
export const basePathOf = (baseUrl: string): string =>
  String.endsWith("/")(baseUrl) ? baseUrl.slice(0, -1) : baseUrl;

/** Remove the base path so routes match whatever prefix the app is served under. */
export const stripBasePath =
  (basePath: string) =>
  (pathname: string): string =>
    basePath !== "" && (pathname === basePath || pathname.startsWith(`${basePath}/`))
      ? pathname.slice(basePath.length) || "/"
      : pathname;

/** The app may be served under a path prefix (Vite `base`). */
const basePath = basePathOf(import.meta.env.BASE_URL);

const stripBase = stripBasePath(basePath);

export const withBase = (path: string): string => `${basePath}${path}`;

export const urlToAppRoute = (url: Url): AppRoute =>
  parseRoute(modifyFields(url, { pathname: stripBase }));

const routePath = (route: AppRoute): string =>
  AppRoute.match(route, {
    TypeList: () => typeListRouter(),
    TypeDetail: ({ name }) => typeDetailRouter({ name }),
    NewVersion: ({ name }) => newVersionRouter({ name }),
    TypeIndexes: ({ name }) => typeIndexesRouter({ name }),
    EntityDetail: ({ id }) => entityDetailRouter({ id }),
    NotFound: ({ path }) => path,
  });

/** The href for a route, including the base path. */
export const href = (route: AppRoute): string => withBase(routePath(route));
