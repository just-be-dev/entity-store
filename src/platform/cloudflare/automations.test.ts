import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { NOT_CONNECTED } from "../../consumers/directory.ts";
import { bindsAutomations, directoryFrom, stubTransport } from "./automations.ts";

const reasonOf = (effect: Effect.Effect<unknown, { readonly reason: string }>) =>
  Effect.map(Effect.flip(effect), (error) => error.reason);

describe("automations binding", () => {
  it("binds only deployed prod", () => {
    expect(bindsAutomations("prod", false)).toBe(true);
    expect(bindsAutomations("prod", true)).toBe(false);
    expect(bindsAutomations("b-feature-1a2b", false)).toBe(false);
    expect(bindsAutomations("dev_me", true)).toBe(false);
  });

  it.effect("without a binding, automations isn't connected", () =>
    Effect.gen(function* () {
      for (const binding of [undefined, {}, { mcp: "no" }, null]) {
        expect(yield* reasonOf(directoryFrom(binding).usage)).toBe(NOT_CONNECTED);
      }
    }),
  );

  it.effect("calls mcp as a member of the stub, with no person", () =>
    Effect.gen(function* () {
      const calls: Array<[unknown, unknown]> = [];
      const stub = {
        name: "stub",
        mcp(this: { name: string }, body: unknown, headers: unknown) {
          expect(this.name).toBe("stub");
          calls.push([body, headers]);
          return Promise.resolve({ status: 200, body: { jsonrpc: "2.0", id: 1, result: {} } });
        },
      };
      const answer = yield* stubTransport(stub).send({ jsonrpc: "2.0", id: 1, method: "ping" });
      expect(answer).toEqual({ status: 200, body: { jsonrpc: "2.0", id: 1, result: {} } });
      expect(calls).toEqual([[{ jsonrpc: "2.0", id: 1, method: "ping" }, {}]]);
    }),
  );

  it.effect("a rejected or throwing call is AutomationsUnavailable", () =>
    Effect.gen(function* () {
      const rejecting = { mcp: () => Promise.reject(new Error("Worker threw")) };
      expect(yield* reasonOf(stubTransport(rejecting).send({}))).toBe(
        "couldn't reach automations: Worker threw",
      );
      const throwing = {
        mcp: () => {
          throw new Error("no such method");
        },
      };
      expect(yield* reasonOf(stubTransport(throwing).send({}))).toBe(
        "couldn't reach automations: no such method",
      );
      // Through the directory, the reason is the transport's.
      expect(yield* reasonOf(directoryFrom(rejecting).usage)).toBe(
        "couldn't reach automations: Worker threw",
      );
    }),
  );

  it.live("a call that takes too long times out", () =>
    Effect.gen(function* () {
      const hanging = { mcp: () => new Promise(() => {}) };
      expect(yield* reasonOf(stubTransport(hanging, "20 millis").send({}))).toBe(
        "automations didn't answer in time",
      );
    }),
  );
});
