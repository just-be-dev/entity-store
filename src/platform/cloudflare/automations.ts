/**
 * The automations app's API Worker (stack `automations`, logical ID `Api`),
 * bound to entity-store's API Worker as a raw service binding, so the API can
 * ask which automations and templates use a type (`src/consumers/`). It's
 * asked over automations' existing `mcp(body, headers)` RPC method. RPC
 * methods aren't routed over HTTP: holding the binding is the authorization.
 * Alchemy's typed service bindings don't take a Worker from another stack, so
 * this registers the raw binding, as automations' own `entity-store.ts` does.
 *
 * Only the `prod` stage binds it: automations runs only against entity-store's
 * prod, and a ref to a stage automations doesn't have would fail the deploy.
 * Under `alchemy dev` and on every other stage nothing is bound, and the
 * directory says automations isn't connected.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { AutomationsDirectory } from "../../consumers/directory.ts";
import type { McpTransport } from "../../consumers/mcp.ts";
import { directoryOverMcp, messageOf } from "../../consumers/mcp.ts";
import { AutomationsUnavailable } from "../../consumers/model.ts";
import { isDev } from "./access.ts";

const AUTOMATIONS_STACK = "automations";
/** The only stage that binds automations, and the stage of automations it binds. */
export const AUTOMATIONS_STAGE = "prod";
const BINDING = "AUTOMATIONS";
/** How long one `mcp` call may take before automations counts as unavailable. */
export const MCP_TIMEOUT: Duration.Input = "4 seconds";

/** What the binding exposes that entity-store uses. */
export interface McpStub {
  readonly mcp: (body: unknown, headers: Readonly<Record<string, string>>) => unknown;
}

const isMcpStub = (value: unknown): value is McpStub =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { readonly mcp?: unknown }).mcp === "function";

/** Whether this deployment binds automations: deployed (not `alchemy dev`) on the prod stage. */
export const bindsAutomations = (stage: string, dev: boolean) =>
  !dev && stage === AUTOMATIONS_STAGE;

/**
 * Sends one MCP message through the stub. Read-only tools need no person, so
 * no headers. A rejected call or one slower than {@link MCP_TIMEOUT} is
 * AutomationsUnavailable; the answer is decoded by `directoryOverMcp`.
 */
export const stubTransport = (
  stub: McpStub,
  timeout: Duration.Input = MCP_TIMEOUT,
): McpTransport => ({
  send: (message) =>
    Effect.tryPromise({
      // A member call: any other property of a method stub is itself a remote call.
      try: () => Promise.resolve(stub.mcp(message, {})),
      catch: (error) =>
        new AutomationsUnavailable({ reason: `couldn't reach automations: ${messageOf(error)}` }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(new AutomationsUnavailable({ reason: "automations didn't answer in time" })),
      }),
      Effect.withSpan("Automations.mcp"),
    ),
});

/** The directory over whatever `env` holds: the bound stub, or not connected. */
export const directoryFrom = (binding: unknown): AutomationsDirectory["Service"] =>
  isMcpStub(binding)
    ? directoryOverMcp(stubTransport(binding))
    : AutomationsDirectory.unavailable();

/**
 * Binds automations on prod at plan time. Yield it in the API Worker's outer
 * Effect; call the function it returns per request, where the env is populated.
 */
export const bindAutomations = Effect.gen(function* () {
  const env: Record<string, unknown> = yield* Cloudflare.Workers.WorkerEnvironment;
  if (!globalThis.__ALCHEMY_RUNTIME__) {
    const { stage } = yield* Alchemy.Stack;
    if (bindsAutomations(stage, isDev)) {
      const api = yield* Cloudflare.Worker.ref("Api", {
        stack: AUTOMATIONS_STACK,
        stage: AUTOMATIONS_STAGE,
      });
      yield* (yield* Cloudflare.Worker).bind`${BINDING}`({
        bindings: [{ type: "service", name: BINDING, service: api.workerName }],
      });
    }
  }
  return () => directoryFrom(env[BINDING]);
});
