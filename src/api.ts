import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { entityRoutes } from "./http/entities.ts";
import { json } from "./http/response.ts";
import { AppInfo } from "./service.ts";

export const apiRoutes = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    "/api/health",
    Effect.gen(function* () {
      const info = yield* AppInfo;
      return json(yield* info.read);
    }),
  ),
  entityRoutes,
  HttpRouter.add("*", "*", json({ error: "Not found" }, 404)),
);
