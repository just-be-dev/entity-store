import * as Schema from "effect/Schema";

/**
 * Lenses are data. A lens connects schema version N to N+1 as a list of
 * bidirectional operations, inspired by Cambria. Every op knows how to run
 * forward (N → N+1) and backward (N+1 → N), so one definition serves new
 * readers of old data and old readers of new data.
 *
 * `derive` is the escape hatch: it computes fields with expressions in the
 * lens expression language (see `expr.ts`), one set per direction.
 */

export type JsonValue = Schema.Json;

export type LensOp =
  | { readonly op: "rename"; readonly from: string; readonly to: string }
  /** Forward sets `default` when the field is absent (omit it for optional fields); backward removes. */
  | { readonly op: "add"; readonly field: string; readonly default?: JsonValue }
  /** Forward removes; backward restores `default` (omit it if the old field was optional). */
  | { readonly op: "remove"; readonly field: string; readonly default?: JsonValue }
  | {
      readonly op: "convert";
      readonly field: string;
      readonly mapping: ReadonlyArray<readonly [JsonValue, JsonValue]>;
      readonly fallback?: { readonly forward?: JsonValue; readonly backward?: JsonValue };
    }
  | { readonly op: "in"; readonly field: string; readonly ops: ReadonlyArray<LensOp> }
  | { readonly op: "each"; readonly field: string; readonly ops: ReadonlyArray<LensOp> }
  | { readonly op: "hoist"; readonly host: string; readonly field: string }
  | { readonly op: "plunge"; readonly host: string; readonly field: string }
  | {
      readonly op: "derive";
      readonly forward: { readonly [field: string]: string };
      readonly backward: { readonly [field: string]: string };
    };

const OpsRef = Schema.suspend(
  (): Schema.Codec<ReadonlyArray<LensOp>> => Schema.Array(LensOp),
);

export const LensOp: Schema.Codec<LensOp> = Schema.Union([
  Schema.Struct({ op: Schema.Literal("rename"), from: Schema.String, to: Schema.String }),
  Schema.Struct({
    op: Schema.Literal("add"),
    field: Schema.String,
    default: Schema.optionalKey(Schema.Json),
  }),
  Schema.Struct({
    op: Schema.Literal("remove"),
    field: Schema.String,
    default: Schema.optionalKey(Schema.Json),
  }),
  Schema.Struct({
    op: Schema.Literal("convert"),
    field: Schema.String,
    mapping: Schema.Array(Schema.Tuple([Schema.Json, Schema.Json])),
    fallback: Schema.optionalKey(
      Schema.Struct({
        forward: Schema.optionalKey(Schema.Json),
        backward: Schema.optionalKey(Schema.Json),
      }),
    ),
  }),
  Schema.Struct({ op: Schema.Literal("in"), field: Schema.String, ops: OpsRef }),
  Schema.Struct({ op: Schema.Literal("each"), field: Schema.String, ops: OpsRef }),
  Schema.Struct({ op: Schema.Literal("hoist"), host: Schema.String, field: Schema.String }),
  Schema.Struct({ op: Schema.Literal("plunge"), host: Schema.String, field: Schema.String }),
  Schema.Struct({
    op: Schema.Literal("derive"),
    forward: Schema.Record(Schema.String, Schema.String),
    backward: Schema.Record(Schema.String, Schema.String),
  }),
]);

export const Lens = Schema.Struct({ ops: Schema.Array(LensOp) });
export type Lens = typeof Lens.Type;

export const Direction = Schema.Literals(["forward", "backward"]);
export type Direction = typeof Direction.Type;
