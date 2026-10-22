import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { ChangeEvent, ChangeMeta, Operation } from "./model.ts";
import { Operation as OperationSchema, StorageFailure } from "./model.ts";
import { decodeRows } from "./registry.ts";
import { SqlDatabase, sql } from "./sql.ts";

/**
 * The change feed: `entity_changes` gets one row per committed write (in the
 * write's own batch), and the flusher delivers rows after a cursor to a
 * queue. Delivery is at least once; consumers dedupe by `(id, rev)`.
 */

export const ChangeRow = Schema.Struct({
  seq: Schema.Int,
  entity_id: Schema.String,
  type: Schema.String,
  rev: Schema.Int,
  op: OperationSchema,
  meta: Schema.NullOr(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))),
  created_at: Schema.Number,
});
export type ChangeRow = typeof ChangeRow.Type;

export const toChangeEvent = (row: ChangeRow): ChangeEvent => ({
  v: 1,
  seq: row.seq,
  type: row.type,
  id: row.entity_id as ChangeEvent["id"],
  rev: row.rev,
  op: row.op,
  meta: row.meta,
  createdAt: row.created_at,
});

/** The statement that records a write's change. Goes in the write's batch. */
export const recordChange = (change: {
  readonly id: string;
  readonly type: string;
  readonly rev: number;
  readonly op: Operation;
  readonly meta: ChangeMeta | undefined;
  readonly at: number;
}) =>
  sql(
    "INSERT INTO entity_changes (entity_id, type, rev, op, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    change.id,
    change.type,
    change.rev,
    change.op,
    change.meta === undefined ? null : JSON.stringify(change.meta),
    change.at,
  );

// ─── Delivery ───────────────────────────────────────────────────────────────

/** The queue couldn't take a batch. Nothing is skipped: the next flush resends it. */
export class ChangeQueueError extends Schema.TaggedError<ChangeQueueError>()("ChangeQueueError", {
  message: Schema.String,
}) {}

/** Where change events go. The platform provides it (a Cloudflare Queue). */
export class ChangeQueue extends Context.Service<
  ChangeQueue,
  {
    /** Send up to {@link FLUSH_BATCH} events; all or none are accepted. */
    readonly sendBatch: (
      events: ReadonlyArray<ChangeEvent>,
    ) => Effect.Effect<void, ChangeQueueError>;
  }
>()("entity-store/ChangeQueue") {}

/** Events per send: a Queue `sendBatch` takes at most 100 messages. */
export const FLUSH_BATCH = 100;

/**
 * Runs `run` at most once at a time per instance (an isolate). A trigger
 * while it runs doesn't start another run. It marks the current one dirty,
 * so it runs once more when it finishes, picking up whatever the triggers
 * wrote. N concurrent writes then cause two flushes, not N flushes that each
 * resend the same unsent window. A failed run stops the loop; the next
 * trigger (or the cron) starts again.
 */
export const singleFlight = <E, R>(
  run: Effect.Effect<unknown, E, R>,
): Effect.Effect<void, E, R> => {
  let running = false;
  let dirty = false;
  const loop: Effect.Effect<void, E, R> = Effect.suspend(() => {
    dirty = false;
    return Effect.andThen(
      run,
      Effect.suspend(() => (dirty ? loop : Effect.void)),
    );
  });
  return Effect.suspend(() => {
    if (running) {
      dirty = true;
      return Effect.void;
    }
    running = true;
    return loop.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          running = false;
        }),
      ),
    );
  });
};

/** The cursor the queue flusher advances. */
const CURSOR = "queue";

const PendingRow = Schema.Struct({
  after_seq: Schema.Int,
  seq: Schema.NullOr(Schema.Int),
});

export interface FlushResult {
  /** Events sent, including any another flusher also sent. */
  readonly sent: number;
  /** The cursor after this flush. */
  readonly after: number;
}

/**
 * Sends changes after the delivery cursor to the queue in batches, then
 * advances the cursor with a conditional update. A failed send leaves the
 * cursor where it was, so those changes go out on the next flush; nothing is
 * skipped. Two concurrent flushers may both send a batch (consumers see a
 * duplicate), but the cursor never moves backwards. Order isn't guaranteed to
 * consumers: a resent batch can arrive after later ones.
 */
export class ChangeDelivery extends Context.Service<
  ChangeDelivery,
  {
    readonly flush: (options: {
      readonly maxBatches: number;
    }) => Effect.Effect<FlushResult, StorageFailure | ChangeQueueError>;
  }
>()("entity-store/ChangeDelivery") {
  static readonly layer = Layer.effect(
    ChangeDelivery,
    Effect.gen(function* () {
      const db = yield* SqlDatabase;
      const queue = yield* ChangeQueue;
      const storageFailure = (error: { readonly message: string }) =>
        new StorageFailure({ message: error.message });

      const flush = Effect.fn("ChangeDelivery.flush")(function* (options: {
        readonly maxBatches: number;
      }) {
        let sent = 0;
        let after = 0;
        for (let batch = 0; batch < options.maxBatches; batch++) {
          // One query reads the cursor and the changes after it.
          const rows = yield* db
            .all(
              sql(
                "SELECT d.after_seq, c.* FROM change_delivery d LEFT JOIN entity_changes c ON c.seq > d.after_seq WHERE d.name = ? ORDER BY c.seq LIMIT ?",
                CURSOR,
                FLUSH_BATCH,
              ),
            )
            .pipe(Effect.mapError(storageFailure));
          const [head] = yield* decodeRows(PendingRow, "delivery cursor")(rows);
          if (head === undefined) {
            return yield* new StorageFailure({ message: "The change delivery cursor is missing" });
          }
          after = head.after_seq;
          const pending = rows.filter((row) => row["seq"] !== null && row["seq"] !== undefined);
          const events = (yield* decodeRows(ChangeRow, "change")(pending)).map(toChangeEvent);
          const last = events[events.length - 1];
          if (last === undefined) {
            break;
          }
          yield* queue.sendBatch(events);
          sent += events.length;
          const moved = yield* db
            .batch([
              sql(
                "UPDATE change_delivery SET after_seq = ? WHERE name = ? AND after_seq = ?",
                last.seq,
                CURSOR,
                after,
              ),
            ])
            .pipe(Effect.mapError(storageFailure));
          if (moved[0]?.changes !== 1) {
            // Another flusher moved the cursor first; it owns what follows.
            break;
          }
          after = last.seq;
          if (events.length < FLUSH_BATCH) {
            break;
          }
        }
        return { sent, after };
      });

      return ChangeDelivery.of({ flush });
    }),
  );
}
