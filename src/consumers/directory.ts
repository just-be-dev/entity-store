import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AutomationsUsage } from "./model.ts";
import { AutomationsUnavailable } from "./model.ts";

/** Why automations can't be asked on a stage with no binding to it (local dev and previews). */
export const NOT_CONNECTED = "automations isn't connected to this stage";

/**
 * The automations app, as far as entity-store asks it: which automations and
 * templates exist and what they use. Provided per request by the platform
 * (over automations' `mcp` RPC on prod, see `mcp.ts`), or unavailable.
 */
export class AutomationsDirectory extends Context.Service<
  AutomationsDirectory,
  { readonly usage: Effect.Effect<AutomationsUsage, AutomationsUnavailable> }
>()("entity-store/AutomationsDirectory") {
  /** A directory that can never be asked, for stages without automations. */
  static readonly unavailable = (reason: string = NOT_CONNECTED) =>
    AutomationsDirectory.of({ usage: Effect.fail(new AutomationsUnavailable({ reason })) });

  static readonly notConnected = Layer.succeed(
    AutomationsDirectory,
    AutomationsDirectory.unavailable(),
  );
}
