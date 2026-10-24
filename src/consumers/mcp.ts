import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AutomationsDirectory } from "./directory.ts";
import type { AutomationsUsage } from "./model.ts";
import { AutomationEntry, AutomationsUnavailable, TemplateEntry } from "./model.ts";

/**
 * Automations' directory over its MCP server. Automations' API Worker has an
 * RPC method `mcp(body, headers)` that answers one MCP JSON-RPC 2.0 message
 * statelessly with `{ status, body }`, as its `/api/mcp` endpoint would. The
 * two tools used here are read-only, so the call names no person.
 */

/** Sends one JSON-RPC message to automations' `mcp` and returns its raw answer. */
export interface McpTransport {
  readonly send: (message: unknown) => Effect.Effect<unknown, AutomationsUnavailable>;
}

/** What `mcp` returns: the HTTP status `/api/mcp` would send, and the JSON-RPC response. */
const McpReply = Schema.Struct({ status: Schema.Finite, body: Schema.optional(Schema.Unknown) });

const JsonRpcFailure = Schema.Struct({
  error: Schema.Struct({ code: Schema.Finite, message: Schema.String }),
});

const ToolResult = Schema.Struct({
  result: Schema.Struct({
    isError: Schema.optionalKey(Schema.Boolean),
    content: Schema.optionalKey(
      Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) })),
    ),
    structuredContent: Schema.optional(Schema.Unknown),
  }),
});

const ListAutomations = Schema.Struct({ automations: Schema.Array(AutomationEntry) });
const ListTemplates = Schema.Struct({ templates: Schema.Array(TemplateEntry) });

/** How Alchemy's Effect Workers return a failed RPC call (`alchemy/src/Rpc.ts`), by its fields. */
export const isAlchemyErrorEnvelope = (value: unknown): value is { readonly error: unknown } =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === "~alchemy/rpc/error" &&
  "error" in value;

/** A short, readable message from an unknown error value. */
export const messageOf = (error: unknown): string => {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String(error.message)
        : String(error);
  return raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
};

const unavailable = (reason: string) => new AutomationsUnavailable({ reason });

/** Calls one of automations' tools and returns its structured result, or why it couldn't. */
const callTool = Effect.fn("AutomationsMcp.callTool")(function* (
  transport: McpTransport,
  tool: string,
  id: number,
) {
  const raw = yield* transport.send({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: tool, arguments: {} },
  });
  if (isAlchemyErrorEnvelope(raw)) {
    return yield* unavailable(`automations failed: ${messageOf(raw.error)}`);
  }
  const reply = Schema.decodeUnknownOption(McpReply)(raw);
  if (Option.isNone(reply)) {
    return yield* unavailable("automations' answer didn't decode");
  }
  const { status, body } = reply.value;
  if (status !== 200) {
    return yield* unavailable(`automations answered ${tool} with status ${status}`);
  }
  const failure = Schema.decodeUnknownOption(JsonRpcFailure)(body);
  if (Option.isSome(failure)) {
    return yield* unavailable(`automations refused ${tool}: ${messageOf(failure.value.error)}`);
  }
  const result = Schema.decodeUnknownOption(ToolResult)(body);
  if (Option.isNone(result)) {
    return yield* unavailable(`automations' answer to ${tool} didn't decode`);
  }
  const { isError, content, structuredContent } = result.value.result;
  if (isError === true) {
    const text = (content ?? []).flatMap((part) => (part.text === undefined ? [] : [part.text]));
    return yield* unavailable(
      `automations' ${tool} failed: ${messageOf(text.join(" ") || "no reason given")}`,
    );
  }
  return structuredContent;
});

/** Decode a tool's structured result, ignoring fields entity-store doesn't use. */
const decodeResult = <S extends Schema.Codec<any, unknown>>(schema: S, tool: string) => {
  const decode = Schema.decodeUnknownOption(schema);
  return (value: unknown): Effect.Effect<S["Type"], AutomationsUnavailable> =>
    Option.match(decode(value) as Option.Option<S["Type"]>, {
      onNone: () => Effect.fail(unavailable(`automations' ${tool} result didn't decode`)),
      onSome: Effect.succeed,
    });
};

/** The directory over automations' MCP: `list_automations` and `list_templates`, side by side. */
export const directoryOverMcp = (transport: McpTransport) =>
  AutomationsDirectory.of({
    usage: Effect.all(
      [
        callTool(transport, "list_automations", 1).pipe(
          Effect.flatMap(decodeResult(ListAutomations, "list_automations")),
        ),
        callTool(transport, "list_templates", 2).pipe(
          Effect.flatMap(decodeResult(ListTemplates, "list_templates")),
        ),
      ],
      { concurrency: 2 },
    ).pipe(
      Effect.map(([{ automations }, { templates }]): AutomationsUsage => ({
        automations,
        templates,
      })),
      Effect.withSpan("AutomationsDirectory.usage"),
    ),
  });
