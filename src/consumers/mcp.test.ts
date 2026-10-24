import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { directoryOverMcp } from "./mcp.ts";
import type { McpTransport } from "./mcp.ts";
import { AutomationsUnavailable } from "./model.ts";

type Answer = (message: { readonly id: number }) => unknown;

/** A transport answering each tool with `answers[tool]`, recording what was sent. */
const fake = (answers: Record<string, Answer>) => {
  const sent: Array<unknown> = [];
  const transport: McpTransport = {
    send: (message) =>
      Effect.sync(() => {
        sent.push(message);
        const { id, params } = message as { id: number; params: { name: string } };
        return answers[params.name]?.({ id });
      }),
  };
  return { transport, sent };
};

const ok =
  (structuredContent: unknown): Answer =>
  ({ id }) => ({
    status: 200,
    body: {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
        isError: false,
      },
    },
  });

const onboarding = {
  id: "onboarding",
  name: "Onboarding",
  updatedAt: 1,
  saved: {
    trigger: {
      kind: "entity",
      entity: "person",
      fields: ["start"],
      when: { ref: "x", op: "exists" },
    },
    nextRunAt: 5,
  },
  activeRuns: [],
  lastRun: { id: "r1", status: "done" },
};
const welcome = {
  name: "welcome",
  label: "Welcome email",
  description: "For new hires",
  slots: [{ name: "hire", label: "Hire", type: "ref", to: "person" }],
  content: { subject: "Hi {{hire.name}}" },
};

const good = {
  list_automations: ok({ automations: [onboarding] }),
  list_templates: ok({ templates: [welcome] }),
};

const reasonOf = (transport: McpTransport) =>
  Effect.flip(directoryOverMcp(transport).usage).pipe(
    Effect.map((error) => {
      expect(error).toBeInstanceOf(AutomationsUnavailable);
      return error.reason;
    }),
  );

describe("automations' directory over MCP", () => {
  it.effect("calls list_automations and list_templates and keeps what it needs", () =>
    Effect.gen(function* () {
      const { transport, sent } = fake(good);
      const usage = yield* directoryOverMcp(transport).usage;
      expect(usage).toEqual({
        automations: [
          {
            id: "onboarding",
            name: "Onboarding",
            saved: {
              trigger: {
                kind: "entity",
                entity: "person",
                fields: ["start"],
                when: { ref: "x", op: "exists" },
              },
            },
          },
        ],
        templates: [
          {
            name: "welcome",
            label: "Welcome email",
            slots: [{ name: "hire", type: "ref", to: "person" }],
          },
        ],
      });
      expect(sent).toEqual([
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "list_automations", arguments: {} },
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "list_templates", arguments: {} },
        },
      ]);
    }),
  );

  it.effect("decodes automations that failed to read and unknown trigger kinds", () =>
    Effect.gen(function* () {
      const { transport } = fake({
        ...good,
        list_automations: ok({
          automations: [
            { id: "broken", name: "Broken", updatedAt: 1, activeRuns: [], error: "DO timed out" },
            {
              id: "new",
              name: "New",
              updatedAt: 1,
              activeRuns: [],
              saved: { trigger: { kind: "webhook" } },
            },
            { id: "draft", name: "Draft only", updatedAt: 1, activeRuns: [] },
          ],
        }),
      });
      const usage = yield* directoryOverMcp(transport).usage;
      expect(usage.automations).toEqual([
        { id: "broken", name: "Broken", error: "DO timed out" },
        { id: "new", name: "New", saved: { trigger: { kind: "webhook" } } },
        { id: "draft", name: "Draft only" },
      ]);
    }),
  );

  it.effect("reports a tool failure with automations' text", () =>
    Effect.gen(function* () {
      const { transport } = fake({
        ...good,
        list_templates: ({ id }) => ({
          status: 200,
          body: {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: "D1 is down" }], isError: true },
          },
        }),
      });
      expect(yield* reasonOf(transport)).toBe("automations' list_templates failed: D1 is down");
    }),
  );

  it.effect("reports JSON-RPC errors, other statuses, and answers that don't decode", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<[Answer, string]> = [
        [
          ({ id }) => ({
            status: 200,
            body: {
              jsonrpc: "2.0",
              id,
              error: { code: -32601, message: "Unknown method tools/call" },
            },
          }),
          "automations refused list_automations: Unknown method tools/call",
        ],
        [
          () => ({ status: 500, body: undefined }),
          "automations answered list_automations with status 500",
        ],
        [() => ({ status: 202 }), "automations answered list_automations with status 202"],
        [() => "nope", "automations' answer didn't decode"],
        [() => undefined, "automations' answer didn't decode"],
        [
          () => ({ status: 200, body: { jsonrpc: "2.0", id: 1 } }),
          "automations' answer to list_automations didn't decode",
        ],
        [
          ok({ automations: [{ id: 1, name: "x" }] }),
          "automations' list_automations result didn't decode",
        ],
        [ok(undefined), "automations' list_automations result didn't decode"],
        [
          () => ({
            _tag: "~alchemy/rpc/error",
            error: { _tag: "Boom", message: "Worker crashed" },
          }),
          "automations failed: Worker crashed",
        ],
      ];
      for (const [answer, reason] of cases) {
        const { transport } = fake({ ...good, list_automations: answer });
        expect(yield* reasonOf(transport)).toBe(reason);
      }
    }),
  );

  it.effect("passes the transport's own failure through", () =>
    Effect.gen(function* () {
      const transport: McpTransport = {
        send: () =>
          Effect.fail(new AutomationsUnavailable({ reason: "couldn't reach automations: gone" })),
      };
      expect(yield* reasonOf(transport)).toBe("couldn't reach automations: gone");
    }),
  );
});
