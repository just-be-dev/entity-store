import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { compiled } from "../schema/compile.ts";
import type { EntitySchema } from "../schema/model.ts";
import { compileLens } from "./apply.ts";
import { checkLens } from "./check.ts";
import type { Lens } from "./model.ts";

const lensOf = (lens: Lens) => {
  const result = compileLens(lens);
  if (Result.isFailure(result)) {
    throw new Error(JSON.stringify(result.failure));
  }
  return result.success;
};
const ok = <A>(r: Result.Result<A, string>) => {
  if (Result.isFailure(r)) {
    throw new Error(r.failure);
  }
  return r.success;
};

const PersonV1: EntitySchema = {
  fields: {
    firstName: { type: "string", minLength: 1, pattern: "^\\S+$" },
    lastName: { type: "string", minLength: 1, pattern: "^\\S+$" },
    email: { type: "string" },
    status: { type: "enum", values: ["active", "away"] },
  },
};
const PersonV2: EntitySchema = {
  fields: {
    fullName: { type: "string", minLength: 3 },
    contact: { type: "object", fields: { email: { type: "string" } } },
    state: { type: "enum", values: ["online", "offline"] },
    age: { type: "number", integer: true, optional: true },
    tags: { type: "array", items: { type: "string" } },
  },
};
const v1ToV2: Lens = {
  ops: [
    {
      op: "derive",
      forward: { fullName: "firstName + ' ' + lastName" },
      backward: {
        firstName: "split(fullName, ' ')[0]",
        lastName: "join(slice(split(fullName, ' '), 1), ' ')",
      },
    },
    { op: "plunge", host: "contact", field: "email" },
    { op: "rename", from: "status", to: "state" },
    {
      op: "convert",
      field: "state",
      mapping: [
        ["active", "online"],
        ["away", "offline"],
      ],
    },
    { op: "add", field: "tags", default: [] },
  ],
};

describe("lens ops", () => {
  it("transforms forward and backward", () => {
    const lens = lensOf(v1ToV2);
    const v1 = { firstName: "Ada", lastName: "Lovelace", email: "ada@x.io", status: "away" };
    const v2 = ok(lens.forward(v1));
    expect(v2).toEqual({
      fullName: "Ada Lovelace",
      contact: { email: "ada@x.io" },
      state: "offline",
      tags: [],
    });
    expect(ok(lens.backward(v2))).toEqual(v1);
  });

  it("applies backward ops in reverse order", () => {
    const lens = lensOf({
      ops: [
        { op: "rename", from: "a", to: "b" },
        { op: "rename", from: "b", to: "c" },
      ],
    });
    expect(ok(lens.forward({ a: 1 }))).toEqual({ c: 1 });
    expect(ok(lens.backward({ c: 1 }))).toEqual({ a: 1 });
  });

  it("works inside nested objects and array elements", () => {
    const lens = lensOf({
      ops: [
        { op: "in", field: "address", ops: [{ op: "rename", from: "zip", to: "postalCode" }] },
        { op: "each", field: "items", ops: [{ op: "remove", field: "legacy", default: false }] },
        { op: "hoist", host: "meta", field: "owner" },
      ],
    });
    const input = {
      address: { zip: "0150" },
      items: [{ legacy: true, n: 1 }, { n: 2 }],
      meta: { owner: "me", x: 1 },
    };
    const out = ok(lens.forward(input));
    expect(out).toEqual({
      address: { postalCode: "0150" },
      items: [{ n: 1 }, { n: 2 }],
      meta: { x: 1 },
      owner: "me",
    });
    expect(ok(lens.backward(out))).toEqual({
      address: { zip: "0150" },
      items: [
        { n: 1, legacy: false },
        { n: 2, legacy: false },
      ],
      meta: { x: 1, owner: "me" },
    });
  });

  it("derive can transform a field in place in both directions", () => {
    const lens = lensOf({
      ops: [{ op: "derive", forward: { price: "price / 100" }, backward: { price: "price * 100" } }],
    });
    expect(ok(lens.forward({ price: 1250, name: "x" }))).toEqual({ price: 12.5, name: "x" });
    expect(ok(lens.backward({ price: 12.5 }))).toEqual({ price: 1250 });
  });

  it("reports definition problems with paths", () => {
    const result = compileLens({
      ops: [
        { op: "rename", from: "a", to: "__proto__" },
        { op: "in", field: "x", ops: [{ op: "derive", forward: { y: "1 +" }, backward: {} }] },
      ],
    });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.map((i) => i.path)).toEqual(["ops[0]", "ops[1].ops[0].forward.y"]);
    }
  });

  it("surfaces runtime failures as errors, not exceptions", () => {
    const lens = lensOf({
      ops: [{ op: "convert", field: "s", mapping: [["a", "b"]] }],
    });
    const result = lens.forward({ s: "zzz" });
    expect(Result.isFailure(result) && result.failure).toMatch(/no mapping/);
  });
});

describe("lens check", () => {
  it.effect("passes a correct lens and reports round-trip loss as a warning", () =>
    Effect.gen(function* () {
      const report = yield* checkLens({
        from: compiled(PersonV1),
        to: compiled(PersonV2),
        lens: lensOf(v1ToV2),
        existing: [{ firstName: "Ada", lastName: "Lovelace", email: "a@b.c", status: "active" }],
        samples: 50,
      });
      expect(report.forward.failures).toEqual([]);
      expect(report.existing.failures).toEqual([]);
      expect(report.examples.length).toBeGreaterThan(0);
    }),
  );

  it.effect("finds counterexamples for a lens that misses a required field", () =>
    Effect.gen(function* () {
      const broken: Lens = { ops: v1ToV2.ops.filter((op) => op.op !== "add") };
      const report = yield* checkLens({
        from: compiled(PersonV1),
        to: compiled(PersonV2),
        lens: lensOf(broken),
        existing: [],
        samples: 20,
      });
      expect(report.ok).toBe(false);
      expect(report.forward.failures[0]?.error).toMatch(/tags/);
    }),
  );

  it.effect("checks stored documents too", () =>
    Effect.gen(function* () {
      const report = yield* checkLens({
        from: compiled({ fields: { n: { type: "number" } } }),
        to: compiled({ fields: { n: { type: "number", max: 10 } } }),
        lens: lensOf({ ops: [] }),
        existing: [{ n: 99 }],
        samples: 0,
      });
      expect(report.ok).toBe(false);
      expect(report.existing.failures[0]?.input).toEqual({ n: 99 });
    }),
  );
});
