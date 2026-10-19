import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { CompiledSchema } from "../schema/compile.ts";
import type { CompiledLens } from "./apply.ts";
import { jsonEquals } from "./expr.ts";

export const Failure = Schema.Struct({
  input: Schema.Json,
  output: Schema.optionalKey(Schema.Json),
  error: Schema.String,
});
export type Failure = typeof Failure.Type;

export const DirectionReport = Schema.Struct({
  checked: Schema.Int,
  failures: Schema.Array(Failure),
});
export type DirectionReport = typeof DirectionReport.Type;

export const LensReport = Schema.Struct({
  ok: Schema.Boolean,
  forward: DirectionReport,
  backward: DirectionReport,
  /** Stored entities at the old version, pushed through the lens. */
  existing: DirectionReport,
  roundTrip: Schema.Struct({
    checked: Schema.Int,
    lossy: Schema.Int,
    example: Schema.optionalKey(
      Schema.Struct({ input: Schema.Json, forward: Schema.Json, back: Schema.Json }),
    ),
  }),
  /** Example transformations to show people what the lens does. */
  examples: Schema.Array(Schema.Struct({ input: Schema.Json, output: Schema.Json })),
  warnings: Schema.Array(Schema.String),
});
export type LensReport = typeof LensReport.Type;

const MAX_FAILURES = 3;
type Json = Schema.Json;

const runDirection = (
  inputs: ReadonlyArray<unknown>,
  step: (doc: unknown) => Result.Result<Json, string>,
  target: CompiledSchema,
): DirectionReport => {
  const failures: Array<Failure> = [];
  for (const input of inputs) {
    if (failures.length >= MAX_FAILURES) {
      break;
    }
    const output = step(input);
    if (Result.isFailure(output)) {
      failures.push({ input: input as Json, error: output.failure });
      continue;
    }
    const valid = target.validate(output.success);
    if (Result.isFailure(valid)) {
      failures.push({ input: input as Json, output: output.success, error: valid.failure });
    }
  }
  return { checked: inputs.length, failures };
};

const sample = (schema: CompiledSchema, count: number, label: string) =>
  Arbitrary.sampleEffect(Arbitrary.schema(schema.sampling()), { count, size: 8 }).pipe(
    Effect.map((values) => ({ values: values as ReadonlyArray<unknown>, warning: undefined })),
    Effect.orElseSucceed(() => ({
      values: [] as ReadonlyArray<unknown>,
      warning: `Couldn't generate sample ${label} documents (patterns or formats may be too strict); that direction was only checked against stored data.`,
    })),
  );

/**
 * Property-check a lens between two schema versions: random documents of the
 * old version must lens forward into valid new documents and vice versa, and
 * stored documents must survive the forward lens. Round-trip loss is reported
 * as information, since lenses that drop data are legitimate.
 */
export const checkLens = Effect.fn("Lens.check")(function* (options: {
  readonly from: CompiledSchema;
  readonly to: CompiledSchema;
  readonly lens: CompiledLens;
  readonly existing: ReadonlyArray<unknown>;
  readonly samples?: number;
}) {
  const count = options.samples ?? 100;
  const { from, to, lens } = options;
  const fromSamples = yield* sample(from, count, "old-version");
  const toSamples = yield* sample(to, count, "new-version");

  const forward = runDirection(fromSamples.values, lens.forward, to);
  const backward = runDirection(toSamples.values, lens.backward, from);
  const existing = runDirection(options.existing, lens.forward, to);

  let lossy = 0;
  let example: LensReport["roundTrip"]["example"];
  for (const input of fromSamples.values) {
    const there = lens.forward(input);
    if (Result.isFailure(there)) {
      continue;
    }
    const back = lens.backward(there.success);
    if (Result.isSuccess(back) && !jsonEquals(back.success, input as Json)) {
      lossy++;
      example ??= { input: input as Json, forward: there.success, back: back.success };
    }
  }

  const examples = [...options.existing.slice(0, 2), ...fromSamples.values.slice(0, 3)].flatMap(
    (input) => {
      const output = lens.forward(input);
      return Result.isSuccess(output) ? [{ input: input as Json, output: output.success }] : [];
    },
  );

  const warnings = [fromSamples.warning, toSamples.warning].filter(
    (w): w is string => w !== undefined,
  );
  if (lossy > 0) {
    warnings.push(
      `${lossy} of ${fromSamples.values.length} sampled documents don't round-trip (old → new → old). Old writers editing new data may lose those differences.`,
    );
  }

  const report: LensReport = {
    ok:
      forward.failures.length === 0 &&
      backward.failures.length === 0 &&
      existing.failures.length === 0,
    forward,
    backward,
    existing,
    roundTrip: {
      checked: fromSamples.values.length,
      lossy,
      ...(example === undefined ? {} : { example }),
    },
    examples,
    warnings,
  };
  return report;
});
