import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { Principal } from "../auth/identity.ts";
import { Identity } from "../auth/identity.ts";
import { AutomationsDirectory } from "../consumers/directory.ts";
import { EntityStore, VersionCache } from "../entity/store.ts";
import { AppInfo } from "../service.ts";
import { makeSqlite } from "./sqlite.ts";

export const testUser: Principal = { _tag: "User", email: "tester@example.com" };

/**
 * Every service the API routes need, backed by in-memory SQLite. Requests are
 * made as `principal` (a signed-in test user by default); pass `Option.none()`
 * for unauthenticated requests. Automations isn't connected unless a test
 * passes a directory (such as `directoryOverMcp` over a fake transport).
 */
export const testAppLayer = (
  name = "Entity store",
  principal: Option.Option<Principal> = Option.some(testUser),
  automations: AutomationsDirectory["Service"] = AutomationsDirectory.unavailable(),
) =>
  Layer.mergeAll(
    AppInfo.layer(name),
    Layer.succeed(Identity, { principal }),
    Layer.succeed(AutomationsDirectory, automations),
    EntityStore.layer.pipe(Layer.provide(Layer.mergeAll(makeSqlite().layer, VersionCache.layer))),
  );
