import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChangeQueue, ChangeQueueError } from "../../entity/changes.ts";

/**
 * The queue entity-store sends change events to: one `ChangeEvent` per
 * message body. It's named `entity-store-<stage>-changes`, and consumers in
 * other stacks reference it by logical ID `Changes` (see docs/api.md).
 * entity-store declares no consumer.
 */
export const ChangesQueue = Cloudflare.Queues.Queue(
  "Changes",
  // `Alchemy.Stack` (not `Alchemy.Stage`) is available at plan time and at
  // runtime, where Worker init evaluates these props again.
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    return { name: `entity-store-${stage}-changes` };
  }),
);

/**
 * ChangeQueue on a Worker queue producer binding. Build it per request or
 * event: it captures the RuntimeContext, so the flusher stays free of
 * platform requirements.
 */
export const changeQueue = (client: Cloudflare.Queues.WriteQueueClient) =>
  Layer.effect(
    ChangeQueue,
    Effect.gen(function* () {
      const context = yield* Effect.context<Alchemy.RuntimeContext>();
      return ChangeQueue.of({
        sendBatch: (events) =>
          client.sendBatch(events.map((body) => ({ body, contentType: "json" }))).pipe(
            Effect.provideContext(context),
            Effect.mapError((error) => new ChangeQueueError({ message: error.message })),
          ),
      });
    }),
  );
