import * as Array from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { defineTaggedUnion } from "foldkit/schema";
import type { AutomationUse, AutomationsUsage } from "./entityStore.ts";

// What follows from a write, beyond the write itself: the change event
// automations turns it into, and which automations start or are affected.
// Computed from what `GET /api/types/:type/consumers` reported, which is
// automations' saved triggers and template slots.

/** The write a confirmation is for, as far as its consequences go. */
export const Impact = defineTaggedUnion({
  EntityWrite: {
    type: Schema.String,
    op: Schema.Literals(["create", "update", "delete"]),
    changed: Schema.Array(Schema.String),
  },
  TypeSave: {
    type: Schema.String,
    isNew: Schema.Boolean,
    renamed: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String })),
    removed: Schema.Array(Schema.String),
  },
  TypeDelete: { type: Schema.String },
  IndexWrite: { type: Schema.String },
});
export type Impact = typeof Impact.Type;

export const Tone = Schema.Literals(["starts", "maybe", "affected", "info", "warning"]);
export type Tone = typeof Tone.Type;

export interface Consequence {
  readonly tone: Tone;
  readonly text: string;
}

/** automations reads only types whose names are snake_case identifiers. */
const automationsSees = (type: string) => /^[a-z][a-z0-9_]{0,39}$/.test(type);

export const eventOf = (op: "create" | "update" | "delete") =>
  op === "create" ? "entity.created" : op === "update" ? "entity.updated" : "entity.deleted";

const nameOf = (use: AutomationUse) => (use.name === "" ? use.id : `${use.name} (${use.id})`);

const when = (use: AutomationUse) => (use.trigger.hasCondition ? ", if its condition holds" : "");

/** Whether and how an automation starts from an entity write. */
const writeConsequence = (
  use: AutomationUse,
  type: string,
  op: "create" | "update" | "delete",
  changed: ReadonlyArray<string>,
): Consequence => {
  const trigger = use.trigger;
  const event = eventOf(op);
  if (trigger.kind === "event") {
    return Option.contains(trigger.event, event)
      ? {
          tone: use.trigger.hasCondition ? "maybe" : "starts",
          text: `${nameOf(use)} starts on ${event}${when(use)}`,
        }
      : {
          tone: "info",
          text: `${nameOf(use)} listens for ${Option.getOrElse(trigger.event, () => "another event")}, not ${event}`,
        };
  }
  if (trigger.kind === "entity") {
    if (op === "delete") {
      return { tone: "info", text: `${nameOf(use)} watches ${type}, but deletes don't start it` };
    }
    if (op === "create") {
      return {
        tone: use.trigger.hasCondition ? "maybe" : "starts",
        text: `${nameOf(use)} starts for a new ${type}${when(use)}`,
      };
    }
    return Option.match(trigger.fields, {
      onNone: () =>
        Array.isReadonlyArrayEmpty(changed)
          ? { tone: "info", text: `${nameOf(use)} watches ${type}, but no field changes` }
          : {
              tone: use.trigger.hasCondition ? "maybe" : "starts",
              text: `${nameOf(use)} starts when any field of a ${type} changes${when(use)}`,
            },
      onSome: (fields) => {
        const hit = Array.intersection(fields, changed);
        return Array.isReadonlyArrayEmpty(hit)
          ? {
              tone: "info",
              text: `${nameOf(use)} watches ${fields.join(", ")}, which this doesn't change`,
            }
          : {
              tone: use.trigger.hasCondition ? "maybe" : "starts",
              text: `${nameOf(use)} starts because ${hit.join(", ")} changed${when(use)}`,
            };
      },
    });
  }
  return {
    tone: "info",
    text: `${nameOf(use)} uses ${type} (${trigger.kind} trigger); writes don't start it`,
  };
};

const unavailable = (reason: string): Consequence => ({
  tone: "warning",
  text: `Couldn't check automations: ${reason}. Automations that use this type may be affected.`,
});

const uncheckedLines = (usage: Extract<AutomationsUsage, { status: "checked" }>) =>
  Array.map(usage.unchecked, (item): Consequence => ({
    tone: "warning",
    text: `Couldn't check ${item.name === "" ? item.id : item.name}: ${item.error}`,
  }));

/** Every consequence of `impact`, given what automations reported (none while it hasn't). */
export const consequencesOf = (
  impact: Impact,
  usage: AutomationsUsage,
): ReadonlyArray<Consequence> =>
  Impact.match<ReadonlyArray<Consequence>>(impact, {
    EntityWrite: ({ type, op, changed }) => {
      const event = eventOf(op);
      const recorded: Consequence = automationsSees(type)
        ? { tone: "info", text: `Records a change that automations receives as ${event}` }
        : {
            tone: "info",
            text: `Records a change. automations ignores ${type}: its name isn't snake_case, so no ${event} event`,
          };
      if (usage.status === "unavailable") {
        return [recorded, unavailable(usage.reason)];
      }
      const uses = [...usage.watching, ...usage.listening];
      return [
        recorded,
        ...Array.match(uses, {
          onEmpty: (): ReadonlyArray<Consequence> => [
            { tone: "info", text: `No saved automation watches ${type} or ${event}` },
          ],
          onNonEmpty: (all) => Array.map(all, (use) => writeConsequence(use, type, op, changed)),
        }),
        ...uncheckedLines(usage),
      ];
    },
    TypeSave: ({ type, isNew, renamed, removed }) => {
      const stored: ReadonlyArray<Consequence> = isNew
        ? [{ tone: "info", text: `Creates ${type} at v1. Nothing is written to entities.` }]
        : [
            {
              tone: "info",
              text: "Stored entities keep their data; reads lens them to the new version, and writers that name an older version keep working.",
            },
          ];
      if (isNew) {
        return stored;
      }
      if (usage.status === "unavailable") {
        return [...stored, unavailable(usage.reason)];
      }
      const touched = [
        ...Array.map(renamed, ({ from, to }) => ({ field: from, text: `renamed to ${to}` })),
        ...Array.map(removed, (field) => ({ field, text: "removed" })),
      ];
      const affected = Array.map(usage.watching, (use): Consequence => {
        const fields: ReadonlyArray<string> = Option.getOrElse(use.trigger.fields, () => []);
        const hit = Array.filter(touched, ({ field }) => fields.includes(field));
        return Array.isReadonlyArrayNonEmpty(hit)
          ? {
              tone: "warning",
              text: `${nameOf(use)} watches ${hit.map(({ field, text }) => `${field} (${text})`).join(", ")}: update its trigger`,
            }
          : {
              tone: Array.isReadonlyArrayEmpty(touched) ? "info" : "affected",
              text: Array.isReadonlyArrayEmpty(touched)
                ? `${nameOf(use)} uses ${type}; it reads the new version`
                : `${nameOf(use)} uses ${type} and reads the new version: check its steps for ${touched.map(({ field }) => field).join(", ")}`,
            };
      });
      const slots = Array.map(usage.templateSlots, (slot): Consequence => ({
        tone: "info",
        text: `Template ${slot.label || slot.template} fills its ${slot.slot} slot from a ${type}`,
      }));
      return [
        ...stored,
        ...Array.match([...affected, ...slots], {
          onEmpty: (): ReadonlyArray<Consequence> => [
            { tone: "info", text: `No saved automation or template uses ${type}` },
          ],
          onNonEmpty: (lines) => lines,
        }),
        ...uncheckedLines(usage),
      ];
    },
    TypeDelete: ({ type }) => {
      const removes: Consequence = {
        tone: "info",
        text: `Deletes ${type}'s versions and indexes, and the history of its deleted entities. ${type} can be created again from v1.`,
      };
      if (usage.status === "unavailable") {
        return [removes, unavailable(usage.reason)];
      }
      return [
        removes,
        ...(Array.isReadonlyArrayEmpty(usage.watching) &&
        Array.isReadonlyArrayEmpty(usage.templateSlots)
          ? [{ tone: "info" as const, text: `No saved automation or template uses ${type}` }]
          : []),
        ...uncheckedLines(usage),
      ];
    },
    IndexWrite: () => [
      { tone: "info", text: "Indexes don't change entity data and record no change." },
    ],
  });
