import * as Schema from "effect/Schema";

/**
 * Who consumes an entity type outside entity-store: the automations app's
 * automations (their saved triggers) and its templates (their ref slots).
 * entity-store doesn't know about automations; it asks automations, and says
 * so when it can't.
 */

/** Automations couldn't be asked: it isn't bound, didn't answer, or answered something unreadable. */
export class AutomationsUnavailable extends Schema.TaggedError<AutomationsUnavailable>()(
  "AutomationsUnavailable",
  { reason: Schema.String },
) {}

// ─── What automations reports (decoded leniently) ───────────────────────────

/**
 * A saved trigger, keeping only what says which type it's about. Automations'
 * Trigger is a union on `kind` (manual, entity, event, schedule, date); other
 * fields are ignored, and `when` is kept only to tell whether there is one.
 */
export const SavedTrigger = Schema.Struct({
  kind: Schema.String,
  entity: Schema.optionalKey(Schema.String),
  subject: Schema.optionalKey(Schema.String),
  event: Schema.optionalKey(Schema.String),
  fields: Schema.optionalKey(Schema.Array(Schema.String)),
  when: Schema.optionalKey(Schema.Unknown),
});
export type SavedTrigger = typeof SavedTrigger.Type;

/** One entry of automations' `list_automations`. `error`: it couldn't be read. */
export const AutomationEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  saved: Schema.optionalKey(Schema.Struct({ trigger: SavedTrigger })),
  error: Schema.optionalKey(Schema.String),
});
export type AutomationEntry = typeof AutomationEntry.Type;

/** One entry of automations' `list_templates`. A `ref` slot points at the type in `to`. */
export const TemplateEntry = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  slots: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      type: Schema.String,
      to: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type TemplateEntry = typeof TemplateEntry.Type;

/** Everything automations reported, before it's matched to a type. */
export interface AutomationsUsage {
  readonly automations: ReadonlyArray<AutomationEntry>;
  readonly templates: ReadonlyArray<TemplateEntry>;
}

// ─── What entity-store reports ──────────────────────────────────────────────

export const TriggerKind = Schema.Literals(["manual", "entity", "event", "schedule", "date"]);
export type TriggerKind = typeof TriggerKind.Type;

/** An automation whose saved trigger concerns the type, and how. */
export const AutomationUse = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  trigger: Schema.Struct({
    kind: TriggerKind,
    /** The event an event trigger listens for. */
    event: Schema.optionalKey(Schema.String),
    /** The fields an entity trigger watches; absent means any field. */
    fields: Schema.optionalKey(Schema.Array(Schema.String)),
    /** Whether the trigger has a `when` condition. */
    hasCondition: Schema.Boolean,
  }),
});
export type AutomationUse = typeof AutomationUse.Type;

/** A template slot that's a ref to the type. `label` is the template's. */
export const TemplateSlotUse = Schema.Struct({
  template: Schema.String,
  label: Schema.String,
  slot: Schema.String,
});
export type TemplateSlotUse = typeof TemplateSlotUse.Type;

/** An automation automations couldn't read, or whose trigger entity-store doesn't understand. */
export const UncheckedAutomation = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  error: Schema.String,
});
export type UncheckedAutomation = typeof UncheckedAutomation.Type;

export const AutomationsConsumers = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("checked"),
    /** Saved triggers about this type: its entities start runs or are their subject. */
    watching: Schema.Array(AutomationUse),
    /** Saved `entity.created|updated|deleted` event triggers with no subject: every type's writes. */
    listening: Schema.Array(AutomationUse),
    templateSlots: Schema.Array(TemplateSlotUse),
    /** Automations that couldn't be checked. Never read their absence as "unused". */
    unchecked: Schema.Array(UncheckedAutomation),
  }),
  Schema.Struct({ status: Schema.Literal("unavailable"), reason: Schema.String }),
]);
export type AutomationsConsumers = typeof AutomationsConsumers.Type;

/** What `GET /api/types/:type/consumers` returns. */
export const TypeConsumers = Schema.Struct({
  type: Schema.String,
  automations: AutomationsConsumers,
});
export type TypeConsumers = typeof TypeConsumers.Type;

/** What `POST /api/types/:type/delete/check` returns: `reasons` empty means DELETE would proceed. */
export const TypeDeleteCheck = Schema.Struct({
  type: Schema.String,
  latestVersion: Schema.Finite,
  reasons: Schema.Array(Schema.String),
  consumers: TypeConsumers,
});
export type TypeDeleteCheck = typeof TypeDeleteCheck.Type;
