import * as Layer from "effect/Layer";
import { EntityStore, VersionCache } from "../entity/store.ts";
import { AppInfo } from "../service.ts";
import { makeSqlite } from "./sqlite.ts";

/** Every service the API routes need, backed by in-memory SQLite. */
export const testAppLayer = (name = "Entity store") =>
  Layer.mergeAll(
    AppInfo.layer(name),
    EntityStore.layer.pipe(Layer.provide(Layer.mergeAll(makeSqlite().layer, VersionCache.layer))),
  );
