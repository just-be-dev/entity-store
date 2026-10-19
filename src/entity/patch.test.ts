import { describe, expect, it } from "@effect/vitest";
import { merge3, mergePatch } from "./patch.ts";

describe("merge patch", () => {
  it("merges objects and deletes with null", () => {
    expect(mergePatch({ a: 1, b: { c: 2, d: 3 } }, { a: null, b: { d: 4 }, e: [1] })).toEqual({
      b: { c: 2, d: 4 },
      e: [1],
    });
    expect(mergePatch({ a: 1 }, { ["__proto__"]: { polluted: true } } as never)).toEqual(
      JSON.parse('{"a":1,"__proto__":{"polluted":true}}'),
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("merge3: carrying an old writer's edit onto stored data", () => {
  // `stored` has `done`, which the old writer can't see; base/mine are its
  // before/after lensed up (hidden fields defaulted to false).
  const [a, b] = [
    { title: "a", done: false },
    { title: "b", done: false },
  ] as const;
  const stored = {
    items: [
      { title: "a", done: true },
      { title: "b", done: true },
    ],
    n: 1,
  };
  const base = { items: [a, b], n: 1 };

  it("keeps hidden fields when appending", () => {
    const mine = { ...base, items: [...base.items, { title: "c", done: false }] };
    expect(merge3(base, mine, stored)).toEqual({
      n: 1,
      items: [
        { title: "a", done: true },
        { title: "b", done: true },
        { title: "c", done: false },
      ],
    });
  });

  it("doesn't shift hidden fields onto other elements on insert or remove", () => {
    const inserted = { ...base, items: [{ title: "z", done: false }, ...base.items] };
    expect(merge3(base, inserted, stored)).toEqual({
      n: 1,
      items: [{ title: "z", done: false }, ...stored.items],
    });
    const removed = { ...base, items: [b] };
    expect(merge3(base, removed, stored)).toEqual({ n: 1, items: [stored.items[1]] });
  });

  it("merges an edited element field by field", () => {
    const edited = { ...base, items: [{ title: "A", done: false }, b] };
    expect(merge3(base, edited, stored)).toEqual({
      n: 1,
      items: [
        { title: "A", done: true },
        { title: "b", done: true },
      ],
    });
  });

  it("applies scalar changes and key removals", () => {
    expect(merge3({ a: 1, b: 2 }, { a: 5 }, { a: 1, b: 2, hidden: 3 })).toEqual({
      a: 5,
      hidden: 3,
    });
    expect(merge3({ a: 1 }, { a: 1 }, { a: 1, hidden: 3 })).toEqual({ a: 1, hidden: 3 });
  });
});
