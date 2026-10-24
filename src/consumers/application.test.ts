import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { EntityStore, VersionCache } from "../entity/store.ts";
import { makeSqlite } from "../testing/sqlite.ts";
import {
  automationsReasons,
  checkTypeDelete,
  classifyConsumers,
  deleteType,
  typeConsumers,
} from "./application.ts";
import { AutomationsDirectory, NOT_CONNECTED } from "./directory.ts";
import type { AutomationEntry, AutomationsUsage, SavedTrigger, TemplateEntry } from "./model.ts";

const automation = (id: string, trigger?: SavedTrigger): AutomationEntry => ({
  id,
  name: id.charAt(0).toUpperCase() + id.slice(1),
  ...(trigger === undefined ? {} : { saved: { trigger } }),
});

const usage = (
  automations: ReadonlyArray<AutomationEntry>,
  templates: ReadonlyArray<TemplateEntry> = [],
): AutomationsUsage => ({ automations, templates });

describe("classifyConsumers", () => {
  it("sorts each trigger kind by whether it's about the type", () => {
    const result = classifyConsumers(
      "person",
      usage([
        automation("payroll", { kind: "schedule", entity: "person", when: { ref: "a" } }),
        automation("onboarding", { kind: "entity", entity: "person", fields: ["start"] }),
        automation("birthday", { kind: "date", entity: "person" }),
        automation("review", { kind: "manual", subject: "person" }),
        automation("hired", { kind: "event", event: "person.hired", subject: "person" }),
        automation("changed", { kind: "event", event: "entity.updated", subject: "person" }),
        // Not about person:
        automation("nightly", { kind: "schedule" }),
        automation("adhoc", { kind: "manual" }),
        automation("projects", { kind: "entity", entity: "project" }),
        automation("other", { kind: "manual", subject: "project" }),
        // An entity field that names the type doesn't make a manual trigger about it.
        automation("odd", { kind: "manual", entity: "person" }),
        automation("custom", { kind: "event", event: "invoice.paid" }),
        automation("drafted"),
      ]),
    );
    expect(result.watching).toEqual([
      { id: "birthday", name: "Birthday", trigger: { kind: "date", hasCondition: false } },
      {
        id: "changed",
        name: "Changed",
        trigger: { kind: "event", event: "entity.updated", hasCondition: false },
      },
      {
        id: "hired",
        name: "Hired",
        trigger: { kind: "event", event: "person.hired", hasCondition: false },
      },
      {
        id: "onboarding",
        name: "Onboarding",
        trigger: { kind: "entity", fields: ["start"], hasCondition: false },
      },
      { id: "payroll", name: "Payroll", trigger: { kind: "schedule", hasCondition: true } },
      { id: "review", name: "Review", trigger: { kind: "manual", hasCondition: false } },
    ]);
    expect(result.listening).toEqual([]);
    expect(result.unchecked).toEqual([]);
    expect(result.templateSlots).toEqual([]);
  });

  it("lists entity.* event triggers without a subject as listening to every type", () => {
    const result = classifyConsumers(
      "person",
      usage([
        automation("audit", { kind: "event", event: "entity.deleted" }),
        automation("all", { kind: "event", event: "entity.created", when: { ref: "type" } }),
        automation("touch", { kind: "event", event: "entity.updated", subject: "project" }),
        automation("custom", { kind: "event", event: "entity.archived" }),
      ]),
    );
    expect(result.listening).toEqual([
      {
        id: "all",
        name: "All",
        trigger: { kind: "event", event: "entity.created", hasCondition: true },
      },
      {
        id: "audit",
        name: "Audit",
        trigger: { kind: "event", event: "entity.deleted", hasCondition: false },
      },
    ]);
    expect(result.watching).toEqual([]);
  });

  it("finds template ref slots and lists automations it couldn't check", () => {
    const result = classifyConsumers(
      "person",
      usage(
        [
          { id: "zeta", name: "Zeta", error: "Its Durable Object didn't answer" },
          automation("future", { kind: "webhook", entity: "person" }),
        ],
        [
          {
            name: "welcome",
            label: "Welcome email",
            slots: [
              { name: "manager", type: "ref", to: "person" },
              { name: "hire", type: "ref", to: "person" },
              { name: "team", type: "ref", to: "team" },
              { name: "person", type: "text" },
            ],
          },
          {
            name: "offer",
            label: "Offer",
            slots: [{ name: "candidate", type: "ref", to: "person" }],
          },
        ],
      ),
    );
    expect(result.templateSlots).toEqual([
      { template: "offer", label: "Offer", slot: "candidate" },
      { template: "welcome", label: "Welcome email", slot: "hire" },
      { template: "welcome", label: "Welcome email", slot: "manager" },
    ]);
    expect(result.unchecked).toEqual([
      {
        id: "future",
        name: "Future",
        error: "its trigger kind 'webhook' isn't one entity-store knows",
      },
      { id: "zeta", name: "Zeta", error: "Its Durable Object didn't answer" },
    ]);
    expect(result.watching).toEqual([]);
  });

  it("words delete reasons from watchers and template slots only", () => {
    const consumers = {
      type: "person",
      automations: classifyConsumers(
        "person",
        usage(
          [
            automation("payroll", { kind: "schedule", entity: "person" }),
            automation("onboarding", { kind: "entity", entity: "person" }),
            automation("audit", { kind: "event", event: "entity.deleted" }),
            { id: "broken", name: "Broken", error: "x" },
          ],
          [{ name: "welcome", label: "W", slots: [{ name: "hire", type: "ref", to: "person" }] }],
        ),
      ),
    };
    expect(automationsReasons(consumers)).toEqual([
      "automations use it: onboarding (Onboarding), payroll (Payroll)",
      "template slots point to it: welcome.hire",
    ]);
    const many = classifyConsumers(
      "person",
      usage(
        Array.from({ length: 12 }, (_, i) =>
          automation(`a${String(i).padStart(2, "0")}`, { kind: "entity", entity: "person" }),
        ),
      ),
    );
    expect(automationsReasons({ type: "person", automations: many })[0]).toMatch(
      /^automations use it: a00 \(A00\), .*a09 \(A09\), and 2 more$/,
    );
    expect(
      automationsReasons({ type: "person", automations: { status: "unavailable", reason: "x" } }),
    ).toEqual([]);
  });
});

const Person = { fields: { name: { type: "string" } } } as const;

const appLayer = (directory: AutomationsDirectory["Service"]) =>
  Layer.mergeAll(
    EntityStore.layer.pipe(Layer.provide(Layer.mergeAll(makeSqlite().layer, VersionCache.layer))),
    Layer.succeed(AutomationsDirectory, directory),
  );

/** A directory that answers `answer` and counts how often it was asked. */
const counting = (answer: AutomationsUsage) => {
  const calls = { n: 0 };
  const directory = AutomationsDirectory.of({
    usage: Effect.sync(() => {
      calls.n++;
      return answer;
    }),
  });
  return { calls, directory };
};

const watched = usage(
  [automation("onboarding", { kind: "entity", entity: "person" })],
  [{ name: "welcome", label: "Welcome", slots: [{ name: "hire", type: "ref", to: "person" }] }],
);

describe("type consumers and the delete policy", () => {
  it.effect("typeConsumers needs the type and reports automations as unavailable", () =>
    Effect.gen(function* () {
      const store = yield* EntityStore;
      expect((yield* Effect.flip(typeConsumers("person")))._tag).toBe("TypeNotFound");
      yield* store.createType({ name: "person", schema: Person });
      expect(yield* typeConsumers("person")).toEqual({
        type: "person",
        automations: { status: "unavailable", reason: NOT_CONNECTED },
      });
    }).pipe(Effect.provide(appLayer(AutomationsDirectory.unavailable()))),
  );

  it.effect("refuses to delete a type automations use, with the store's reasons first", () => {
    const { calls, directory } = counting(watched);
    return Effect.gen(function* () {
      const store = yield* EntityStore;
      yield* store.createType({ name: "person", schema: Person });
      yield* store.create("person", { id: "ada", data: { name: "Ada" } });
      const reasons = [
        "it has 1 live entity",
        "automations use it: onboarding (Onboarding)",
        "template slots point to it: welcome.hire",
      ];
      const check = yield* checkTypeDelete("person");
      expect(check).toMatchObject({ type: "person", latestVersion: 1, reasons });
      expect(check.consumers.automations.status).toBe("checked");
      expect(calls.n).toBe(1);
      expect(yield* Effect.flip(deleteType("person"))).toMatchObject({
        _tag: "TypeInUse",
        type: "person",
        reasons,
      });
      yield* store.remove("ada");
      expect(yield* Effect.flip(deleteType("person"))).toMatchObject({ reasons: reasons.slice(1) });
      expect((yield* store.getType("person")).name).toBe("person");
      // The store's own deleteType (the RPC's) doesn't ask automations.
      const before = calls.n;
      expect(yield* store.deleteType("person")).toEqual({ name: "person" });
      expect(calls.n).toBe(before);
    }).pipe(Effect.provide(appLayer(directory)));
  });

  it.effect("deletes when automations is unavailable or doesn't use the type", () =>
    Effect.gen(function* () {
      const store = yield* EntityStore;
      yield* store.createType({ name: "person", schema: Person });
      expect(yield* checkTypeDelete("person")).toMatchObject({ reasons: [] });
      expect(yield* deleteType("person")).toEqual({ name: "person" });
    }).pipe(Effect.provide(appLayer(AutomationsDirectory.unavailable()))),
  );

  it.effect("a stale expectedVersion fails before automations is asked", () => {
    const { calls, directory } = counting(usage([]));
    return Effect.gen(function* () {
      const store = yield* EntityStore;
      yield* store.createType({ name: "person", schema: Person });
      const attempts: ReadonlyArray<
        Effect.Effect<unknown, { readonly _tag: string }, EntityStore | AutomationsDirectory>
      > = [
        checkTypeDelete("person", { expectedVersion: 2 }),
        deleteType("person", { expectedVersion: 2 }),
      ];
      for (const attempt of attempts) {
        expect(yield* Effect.flip(attempt)).toMatchObject({
          _tag: "VersionConflict",
          expected: 2,
          currentVersion: 1,
        });
      }
      expect(calls.n).toBe(0);
      expect((yield* Effect.flip(checkTypeDelete("nope")))._tag).toBe("TypeNotFound");
      expect(yield* deleteType("person", { expectedVersion: 1 })).toEqual({ name: "person" });
      expect(calls.n).toBe(1);
    }).pipe(Effect.provide(appLayer(directory)));
  });
});
