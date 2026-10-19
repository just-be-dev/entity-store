import * as Array from "effect/Array";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import type { Html, HtmlBuilder } from "foldkit/html";
import { jsonBlock } from "@/components/json";
import { badge } from "@/components/ui/badge";
import type { CheckFailure, DirectionReport, LensReport } from "@/domain/entityStore";
import { compactJson } from "@/domain/json";
import { plural } from "@/lib/format";

const labelled = <M>(label: string, value: Schema.Json, h: HtmlBuilder<M>): Html =>
  h.div(
    [h.Class("min-w-0 space-y-1")],
    [
      h.div([h.Class("text-xs font-medium text-muted-foreground")], [label]),
      jsonBlock(value, h, { label, className: "max-h-48" }),
    ],
  );

const failureKey = (failure: CheckFailure) => `${compactJson(failure.input)}:${failure.error}`;

const failureItem = <M>(failure: CheckFailure, h: HtmlBuilder<M>): Html =>
  h.keyed("li")(
    failureKey(failure),
    [h.Class("space-y-2 rounded-lg border border-destructive/30 p-2")],
    [
      h.p([h.Class("text-xs text-destructive")], [failure.error]),
      h.div(
        [h.Class("grid gap-2 md:grid-cols-2")],
        [
          labelled("Input", failure.input, h),
          Option.match(failure.output, {
            onNone: () => h.empty,
            onSome: (output) => labelled("Output", output, h),
          }),
        ],
      ),
    ],
  );

const directionView = <M>(
  title: string,
  explanation: string,
  report: DirectionReport,
  h: HtmlBuilder<M>,
): Html =>
  h.div(
    [h.Class("space-y-2")],
    [
      h.div(
        [h.Class("flex flex-wrap items-center gap-2")],
        [
          h.h4([h.Class("text-sm font-medium")], [title]),
          badge(
            { variant: Array.isReadonlyArrayEmpty(report.failures) ? "secondary" : "destructive" },
            [
              Array.isReadonlyArrayEmpty(report.failures)
                ? `${report.checked} checked, all valid`
                : `${plural(report.failures.length, "counterexample")} of ${report.checked}`,
            ],
            h,
          ),
        ],
      ),
      h.p([h.Class("text-xs text-muted-foreground")], [explanation]),
      Array.match(
        Array.dedupeWith(report.failures, (a, b) => failureKey(a) === failureKey(b)),
        {
          onEmpty: () => h.empty,
          onNonEmpty: (failures) =>
            h.ul(
              [h.Class("space-y-2")],
              Array.map(failures, (failure) => failureItem(failure, h)),
            ),
        },
      ),
    ],
  );

/** A lens check report: per-direction counterexamples, round-trip loss, examples, warnings. */
export const lensReportView = <M>(
  report: LensReport,
  config: Readonly<{ from: Option.Option<number>; to: Option.Option<number> }>,
  h: HtmlBuilder<M>,
): Html => {
  const from = Option.match(config.from, { onNone: () => "old", onSome: (v) => `v${v}` });
  const to = Option.match(config.to, { onNone: () => "new", onSome: (v) => `v${v}` });
  return h.div(
    [h.Class("space-y-5"), h.AriaLabel("Lens check report")],
    [
      h.div(
        [h.Class("flex flex-wrap items-center gap-2")],
        [
          badge(
            { variant: report.ok ? "default" : "destructive" },
            [report.ok ? "Lens check passed" : "Lens check failed"],
            h,
          ),
          h.span([h.Class("font-mono text-xs text-muted-foreground")], [`${from} → ${to}`]),
        ],
      ),
      Array.match(report.warnings, {
        onEmpty: () => h.empty,
        onNonEmpty: (warnings) =>
          h.ul(
            [
              h.Class(
                "space-y-1 rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground",
              ),
              h.AriaLabel("Warnings"),
            ],
            Array.map(Array.dedupe(warnings), (warning) =>
              h.keyed("li")(warning, [], [`⚠ ${warning}`]),
            ),
          ),
      }),
      directionView(
        `Forward (${from} → ${to})`,
        `Random ${from} documents lensed forward must be valid ${to} documents.`,
        report.forward,
        h,
      ),
      directionView(
        `Backward (${to} → ${from})`,
        `Random ${to} documents lensed backward must be valid ${from} documents.`,
        report.backward,
        h,
      ),
      directionView(
        "Stored entities",
        `Up to 50 stored entities, lensed forward, must be valid ${to} documents.`,
        report.existing,
        h,
      ),
      h.div(
        [h.Class("space-y-2")],
        [
          h.div(
            [h.Class("flex flex-wrap items-center gap-2")],
            [
              h.h4([h.Class("text-sm font-medium")], [`Round trip (${from} → ${to} → ${from})`]),
              badge(
                { variant: report.roundTrip.lossy === 0 ? "secondary" : "outline" },
                [`${report.roundTrip.lossy} of ${report.roundTrip.checked} lossy`],
                h,
              ),
            ],
          ),
          Option.match(report.roundTrip.example, {
            onNone: () => h.empty,
            onSome: (example) =>
              h.div(
                [h.Class("grid gap-2 md:grid-cols-3")],
                [
                  labelled(`Input (${from})`, example.input, h),
                  labelled(`Forward (${to})`, example.forward, h),
                  labelled(`Back (${from})`, example.back, h),
                ],
              ),
          }),
        ],
      ),
      Array.match(
        Array.dedupeWith(report.examples, (a, b) => compactJson(a.input) === compactJson(b.input)),
        {
          onEmpty: () => h.empty,
          onNonEmpty: (examples) =>
            h.div(
              [h.Class("space-y-2")],
              [
                h.h4([h.Class("text-sm font-medium")], ["Examples"]),
                h.ul(
                  [h.Class("space-y-2")],
                  Array.map(examples, (example) =>
                    h.keyed("li")(
                      compactJson(example.input),
                      [h.Class("grid gap-2 md:grid-cols-2")],
                      [
                        labelled(`Input (${from})`, example.input, h),
                        labelled(`Output (${to})`, example.output, h),
                      ],
                    ),
                  ),
                ),
              ],
            ),
        },
      ),
    ],
  );
};
