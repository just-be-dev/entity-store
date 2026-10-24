import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { TypeInUse } from "../entity/model.ts";
import type { DeleteTypeOptions } from "../entity/store.ts";
import { EntityStore } from "../entity/store.ts";
import { AutomationsDirectory } from "./directory.ts";
import type {
  AutomationUse,
  AutomationsConsumers,
  AutomationsUsage,
  SavedTrigger,
  TemplateSlotUse,
  TriggerKind,
  TypeConsumers,
  TypeDeleteCheck,
  UncheckedAutomation,
} from "./model.ts";

/** The lifecycle events automations publishes for every entity-store write. */
const ENTITY_EVENTS: ReadonlySet<string> = new Set([
  "entity.created",
  "entity.updated",
  "entity.deleted",
]);

const KINDS: ReadonlySet<string> = new Set<TriggerKind>([
  "manual",
  "entity",
  "event",
  "schedule",
  "date",
]);

const isKind = (kind: string): kind is TriggerKind => KINDS.has(kind);

/** The type a saved trigger is about, as automations reads it (`subjectType`). */
const aboutType = (trigger: SavedTrigger & { readonly kind: TriggerKind }) =>
  trigger.kind === "manual" || trigger.kind === "event" ? trigger.subject : trigger.entity;

const byId = <A extends { readonly id: string }>(a: A, b: A) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * Which of automations' automations and templates use `type` (pure).
 *
 * - **watching**: the saved trigger is about the type: an entity, schedule,
 *   or date trigger on it, or a manual or event trigger with it as subject.
 * - **listening**: a saved event trigger on `entity.created`, `entity.updated`
 *   or `entity.deleted` with no subject, which fires for every type.
 * - **templateSlots**: template slots that are refs to the type.
 * - **unchecked**: automations automations couldn't read, or whose trigger
 *   kind entity-store doesn't know. They may use the type.
 *
 * Automations without a saved workflow are ignored.
 */
export const classifyConsumers = (
  type: string,
  usage: AutomationsUsage,
): Extract<AutomationsConsumers, { readonly status: "checked" }> => {
  const watching: Array<AutomationUse> = [];
  const listening: Array<AutomationUse> = [];
  const unchecked: Array<UncheckedAutomation> = [];
  for (const automation of usage.automations) {
    const { id, name } = automation;
    if (automation.error !== undefined) {
      unchecked.push({ id, name, error: automation.error });
      continue;
    }
    const trigger = automation.saved?.trigger;
    if (trigger === undefined) {
      continue;
    }
    const { kind } = trigger;
    if (!isKind(kind)) {
      unchecked.push({
        id,
        name,
        error: `its trigger kind '${kind}' isn't one entity-store knows`,
      });
      continue;
    }
    const use: AutomationUse = {
      id,
      name,
      trigger: {
        kind,
        ...(kind === "event" && trigger.event !== undefined ? { event: trigger.event } : {}),
        ...(kind === "entity" && trigger.fields !== undefined ? { fields: trigger.fields } : {}),
        hasCondition: trigger.when !== undefined,
      },
    };
    const about = aboutType({ ...trigger, kind });
    if (about === type) {
      watching.push(use);
    } else if (
      kind === "event" &&
      about === undefined &&
      trigger.event !== undefined &&
      ENTITY_EVENTS.has(trigger.event)
    ) {
      listening.push(use);
    }
  }
  const templateSlots: Array<TemplateSlotUse> = usage.templates
    .flatMap((template) =>
      template.slots
        .filter((slot) => slot.type === "ref" && slot.to === type)
        .map((slot) => ({ template: template.name, label: template.label, slot: slot.name })),
    )
    .sort((a, b) =>
      a.template !== b.template
        ? a.template < b.template
          ? -1
          : 1
        : a.slot < b.slot
          ? -1
          : a.slot > b.slot
            ? 1
            : 0,
    );
  return {
    status: "checked",
    watching: watching.sort(byId),
    listening: listening.sort(byId),
    templateSlots,
    unchecked: unchecked.sort(byId),
  };
};

/** Lists at most this many names in a reason, then "and N more". */
const MAX_NAMED = 10;

const listed = (names: ReadonlyArray<string>) =>
  names.length > MAX_NAMED
    ? `${names.slice(0, MAX_NAMED).join(", ")}, and ${names.length - MAX_NAMED} more`
    : names.join(", ");

/** Why automations' use of a type stops its delete (pure). Unavailable or unchecked doesn't. */
export const automationsReasons = (consumers: TypeConsumers): Array<string> => {
  const { automations } = consumers;
  if (automations.status !== "checked") {
    return [];
  }
  const reasons: Array<string> = [];
  if (automations.watching.length > 0) {
    reasons.push(
      `automations use it: ${listed(automations.watching.map((a) => `${a.id} (${a.name})`))}`,
    );
  }
  if (automations.templateSlots.length > 0) {
    reasons.push(
      `template slots point to it: ${listed(automations.templateSlots.map((s) => `${s.template}.${s.slot}`))}`,
    );
  }
  return reasons;
};

/** Ask automations about `type`; its unavailability is part of the answer, not a failure. */
const askAutomations = Effect.fn("Consumers.askAutomations")(function* (type: string) {
  const directory = yield* AutomationsDirectory;
  const usage = yield* Effect.result(directory.usage);
  if (Result.isFailure(usage)) {
    // The reason is in the response; keep it (and anything automations said) out of logs.
    yield* Effect.logWarning("Couldn't ask automations which automations use a type");
    const consumers: TypeConsumers = {
      type,
      automations: { status: "unavailable", reason: usage.failure.reason },
    };
    return consumers;
  }
  const consumers: TypeConsumers = { type, automations: classifyConsumers(type, usage.success) };
  return consumers;
});

/**
 * Which automations and templates use an existing type (TypeNotFound
 * otherwise). Succeeds when automations can't be asked, with
 * `automations.status: "unavailable"` and why.
 */
export const typeConsumers = Effect.fn("Consumers.typeConsumers")(function* (type: string) {
  const store = yield* EntityStore;
  yield* store.getType(type);
  return yield* askAutomations(type);
});

/**
 * A dry run of {@link deleteType}: every reason it would refuse right now,
 * the store's own first, then automations'. Fails like it for a missing type
 * or a stale `expectedVersion`, before asking automations.
 */
export const checkTypeDelete = Effect.fn("Consumers.checkTypeDelete")(function* (
  name: string,
  options?: DeleteTypeOptions,
) {
  const store = yield* EntityStore;
  const own = yield* store.checkDeleteType(name, options);
  const consumers = yield* askAutomations(name);
  const check: TypeDeleteCheck = {
    type: name,
    latestVersion: own.latestVersion,
    reasons: [...own.reasons, ...automationsReasons(consumers)],
    consumers,
  };
  return check;
});

/**
 * Delete a type unless the store or automations says it's in use. Refused
 * with TypeInUse when automations was checked and reports automations whose
 * saved trigger is about the type, or template slots that ref it, alongside
 * the store's own reasons. When automations can't be asked, only the store
 * decides (the UI warns). Automations can start using the type after it's
 * asked; nothing across the two apps prevents that.
 *
 * The store's `deleteType` (and so the RPC's) doesn't ask automations:
 * automations calls the RPC itself and checks its own side first.
 */
export const deleteType = Effect.fn("Consumers.deleteType")(function* (
  name: string,
  options?: DeleteTypeOptions,
) {
  const check = yield* checkTypeDelete(name, options);
  if (check.reasons.length > 0) {
    return yield* new TypeInUse({ type: name, reasons: check.reasons });
  }
  const store = yield* EntityStore;
  // Re-checks the store's reasons and the version inside its batch.
  return yield* store.deleteType(name, options);
});
