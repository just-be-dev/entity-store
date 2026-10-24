import * as Array from "effect/Array";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineTaggedUnion } from "foldkit/schema";
import { failureAlert } from "@/components/feedback";
import { statusText } from "@/components/layout";
import { badge } from "@/components/ui/badge";
import { button, buttonClass } from "@/components/ui/button";
import * as Dialog from "@/components/ui/dialog";
import { type Consequence, Impact, consequencesOf } from "@/domain/consequences";
import { ApiFailure, AutomationsUsage } from "@/domain/entityStore";
import { asObject } from "@/domain/json";
import { cn } from "@/lib/utils";

// The confirmation every write goes through: what changes, field by field,
// what follows (the change event, automations it starts or affects), and
// anything that refuses it. Pages own the pending write; this is its dialog.

/** One changed field. None is "not set" before, or "removed" after. */
export const Detail = Schema.Struct({
  label: Schema.String,
  before: Schema.Option(Schema.String),
  after: Schema.Option(Schema.String),
});
export type Detail = typeof Detail.Type;

export const Proposal = Schema.Struct({
  title: Schema.String,
  summary: Schema.String,
  confirmLabel: Schema.String,
  isDestructive: Schema.Boolean,
  details: Schema.Array(Detail),
  notes: Schema.Array(Schema.String),
  /** Reasons the write can't go ahead. While there are any, confirming is disabled. */
  refusals: Schema.Array(Schema.String),
  impact: Impact,
});
export type Proposal = typeof Proposal.Type;

/** What automations said about the type, fetched when the dialog opens. */
export const Usage = defineTaggedUnion({
  Loading: {},
  Loaded: { usage: AutomationsUsage },
  Failed: { failure: ApiFailure },
});
export type Usage = typeof Usage.Type;

export const Submission = defineTaggedUnion({
  Idle: {},
  Working: {},
  Failed: { failure: ApiFailure },
});
export type Submission = typeof Submission.Type;

export const DIALOG_ID = "confirm-write";

export const initDialog = (): Dialog.Model => Dialog.init({ id: DIALOG_ID, isAnimated: false });

const valueText = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

/** Top-level fields that differ between two documents, as before/after text. */
export const dataDetails = (before: unknown, after: unknown): ReadonlyArray<Detail> => {
  const empty: Readonly<Record<string, unknown>> = {};
  const left = Option.getOrElse(asObject(before), () => empty);
  const right = Option.getOrElse(asObject(after), () => empty);
  const keys = Array.dedupe([...Record.keys(left), ...Record.keys(right)]);
  return Array.filterMap(keys, (key) => {
    const from = Option.fromNullishOr(left[key]);
    const to = Option.fromNullishOr(right[key]);
    const fromText = Option.map(from, valueText);
    const toText = Option.map(to, valueText);
    return Option.getOrUndefined(fromText) === Option.getOrUndefined(toText)
      ? Result.failVoid
      : Result.succeed(Detail.make({ label: key, before: fromText, after: toText }));
  });
};

/** The fields a set of details names, for consequences that depend on which changed. */
export const changedFields = (details: ReadonlyArray<Detail>): ReadonlyArray<string> =>
  Array.map(details, (detail) => detail.label);

const toneClass: Readonly<Record<Consequence["tone"], string>> = {
  starts: "text-foreground",
  maybe: "text-foreground",
  affected: "text-foreground",
  info: "text-muted-foreground",
  warning: "text-amber-700 dark:text-amber-400",
};

const toneLabel: Readonly<Record<Consequence["tone"], string>> = {
  starts: "Starts",
  maybe: "May start",
  affected: "Affected",
  info: "Note",
  warning: "Warning",
};

const consequenceItem = <M>(consequence: Consequence, h: HtmlBuilder<M>): Html =>
  h.keyed("li")(
    consequence.text,
    [h.Class(cn("flex items-baseline gap-2", toneClass[consequence.tone]))],
    [
      badge(
        {
          variant:
            consequence.tone === "warning"
              ? "destructive"
              : consequence.tone === "info"
                ? "outline"
                : "secondary",
          className: "shrink-0",
        },
        [toneLabel[consequence.tone]],
        h,
      ),
      h.span([], [consequence.text]),
    ],
  );

const consequencesView = <M>(impact: Impact, usage: Usage, h: HtmlBuilder<M>): Html =>
  h.section(
    [h.Class("space-y-2"), h.AriaLabel("Consequences")],
    [
      h.h3([h.Class("text-sm font-medium")], ["What follows"]),
      Usage.match(usage, {
        Loading: () => statusText("Checking automations…", h),
        Loaded: ({ usage: loaded }) =>
          h.ul(
            [h.Class("space-y-1.5 text-sm")],
            Array.map(consequencesOf(impact, loaded), (consequence) =>
              consequenceItem(consequence, h),
            ),
          ),
        Failed: ({ failure }) =>
          h.ul(
            [h.Class("space-y-1.5 text-sm")],
            Array.map(
              consequencesOf(
                impact,
                AutomationsUsage.make({ status: "unavailable", reason: failure.error }),
              ),
              (consequence) => consequenceItem(consequence, h),
            ),
          ),
      }),
    ],
  );

const detailText = <M>(text: Option.Option<string>, missing: string, h: HtmlBuilder<M>): Html =>
  Option.match(text, {
    onNone: () => h.span([h.Class("italic text-muted-foreground")], [missing]),
    onSome: (value) =>
      h.span([h.Class("break-words font-mono text-xs")], [value === "" ? "(empty text)" : value]),
  });

const detailsView = <M>(details: ReadonlyArray<Detail>, h: HtmlBuilder<M>): Html =>
  Array.match(details, {
    onEmpty: () => statusText("No field changes.", h),
    onNonEmpty: (nonEmpty) =>
      h.div(
        [h.Class("max-h-72 overflow-auto rounded-lg border border-border")],
        [
          h.table(
            [h.Class("w-full text-left text-sm"), h.AriaLabel("Changes")],
            [
              h.thead(
                [h.Class("bg-muted/50 text-xs text-muted-foreground")],
                [
                  h.tr(
                    [],
                    [
                      h.th([h.Class("px-3 py-1.5 font-medium"), h.Scope("col")], ["Field"]),
                      h.th([h.Class("px-3 py-1.5 font-medium"), h.Scope("col")], ["Before"]),
                      h.th([h.Class("px-3 py-1.5 font-medium"), h.Scope("col")], ["After"]),
                    ],
                  ),
                ],
              ),
              h.tbody(
                [],
                Array.map(nonEmpty, (detail) =>
                  h.keyed("tr")(
                    detail.label,
                    [h.Class("border-t border-border align-top")],
                    [
                      h.th(
                        [h.Scope("row"), h.Class("px-3 py-1.5 font-mono text-xs font-medium")],
                        [detail.label],
                      ),
                      h.td([h.Class("px-3 py-1.5")], [detailText(detail.before, "Not set", h)]),
                      h.td([h.Class("px-3 py-1.5")], [detailText(detail.after, "Removed", h)]),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
  });

const refusalsView = <M>(refusals: ReadonlyArray<string>, h: HtmlBuilder<M>): Html =>
  Array.match(refusals, {
    onEmpty: () => h.empty,
    onNonEmpty: (nonEmpty) =>
      h.div(
        [
          h.Class(
            "rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive",
          ),
          h.Role("alert"),
        ],
        [
          h.p([h.Class("font-medium")], ["This can't be done yet:"]),
          h.ul(
            [h.Class("mt-1 list-disc space-y-0.5 pl-5")],
            Array.map(nonEmpty, (refusal) => h.keyed("li")(refusal, [], [refusal])),
          ),
        ],
      ),
  });

export type ConfirmConfig<M> = Readonly<{
  dialog: Dialog.Model;
  maybeProposal: Option.Option<Proposal>;
  usage: Usage;
  submission: Submission;
  /** A check still running before the write can be confirmed, such as who links to it. */
  maybeChecking?: Option.Option<string>;
  onConfirm: M;
  toDialogMessage: (message: Dialog.Message) => M;
}>;

/** The confirmation dialog for a pending write. */
export const confirmDialog = <M>(config: ConfirmConfig<M>, h: HtmlBuilder<M>): Html =>
  h.submodel({
    slotId: "confirm-write",
    model: config.dialog,
    view: Dialog.view,
    viewInputs: Dialog.styledViewInputs(
      {
        hasDescription: true,
        panelClass: "sm:max-w-2xl max-h-[calc(100dvh-2rem)] overflow-y-auto",
        content: (render, h) =>
          Option.match(config.maybeProposal, {
            onNone: () => [],
            onSome: (proposal) => {
              const isWorking = config.submission._tag === "Working";
              const isRefused = Array.isReadonlyArrayNonEmpty(proposal.refusals);
              const maybeChecking = config.maybeChecking ?? Option.none();
              return [
                Dialog.header(
                  {},
                  [
                    Dialog.title({ attributes: render.title }, [proposal.title], h),
                    Dialog.description({ attributes: render.description }, [proposal.summary], h),
                  ],
                  h,
                ),
                Option.match(maybeChecking, {
                  onNone: () => h.empty,
                  onSome: (checking) => statusText(checking, h),
                }),
                refusalsView(proposal.refusals, h),
                detailsView(proposal.details, h),
                Array.match(proposal.notes, {
                  onEmpty: () => h.empty,
                  onNonEmpty: (notes) =>
                    h.ul(
                      [h.Class("space-y-1 text-sm text-muted-foreground")],
                      Array.map(notes, (note) => h.keyed("li")(note, [], [note])),
                    ),
                }),
                consequencesView(proposal.impact, config.usage, h),
                Submission.match(config.submission, {
                  Idle: () => h.empty,
                  Working: () => statusText("Working…", h),
                  Failed: ({ failure }) => failureAlert(failure, h),
                }),
                Dialog.footer(
                  {},
                  [
                    h.button(
                      [
                        ...render.closeButton,
                        h.Class(buttonClass({ variant: "outline" })),
                        h.Disabled(isWorking),
                      ],
                      ["Cancel"],
                    ),
                    button(
                      {
                        type: "button",
                        variant: proposal.isDestructive ? "destructive" : "default",
                        onClick: config.onConfirm,
                        isDisabled: isWorking || isRefused || Option.isSome(maybeChecking),
                      },
                      isWorking ? "Working…" : proposal.confirmLabel,
                      h,
                    ),
                  ],
                  h,
                ),
              ];
            },
          }),
      },
      h,
    ),
    toParentMessage: config.toDialogMessage,
  });
