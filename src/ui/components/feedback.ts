import * as Array from "effect/Array";
import * as Option from "effect/Option";
import type { Html, HtmlBuilder } from "foldkit/html";
import { badge } from "@/components/ui/badge";
import { entityLink } from "@/components/links";
import type {
  ApiFailure,
  Backlink,
  Issue,
  LinkProblem,
  UniqueConflict,
} from "@/domain/entityStore";

const alertClass =
  "rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive";

/** A plain error message. */
export const errorAlert = <M>(message: string, h: HtmlBuilder<M>): Html =>
  h.div([h.Class(alertClass), h.Role("alert")], [message]);

export const issueList = <M>(issues: ReadonlyArray<Issue>, h: HtmlBuilder<M>): Html =>
  Array.match(issues, {
    onEmpty: () => h.empty,
    onNonEmpty: (nonEmpty) =>
      h.ul(
        [h.Class("mt-2 space-y-1 text-xs")],
        Array.map(nonEmpty, (issue) =>
          h.keyed("li")(
            `${issue.path}:${issue.message}`,
            [h.Class("flex gap-2")],
            [
              h.code(
                [h.Class("shrink-0 font-mono font-semibold")],
                [issue.path === "" ? "(root)" : issue.path],
              ),
              h.span([], [issue.message]),
            ],
          ),
        ),
      ),
  });

const problemList = <M>(problems: ReadonlyArray<LinkProblem>, h: HtmlBuilder<M>): Html =>
  Array.match(problems, {
    onEmpty: () => h.empty,
    onNonEmpty: (nonEmpty) =>
      h.ul(
        [h.Class("mt-2 space-y-1 text-xs"), h.AriaLabel("Invalid links")],
        Array.map(nonEmpty, (problem) =>
          h.keyed("li")(
            `${problem.path}:${problem.target}`,
            [h.Class("flex flex-wrap gap-x-2")],
            [
              h.code([h.Class("font-mono font-semibold")], [problem.path]),
              h.span([], ["→"]),
              h.code([h.Class("font-mono")], [problem.target]),
              h.span([], [problem.message]),
            ],
          ),
        ),
      ),
  });

const linkedFromList = <M>(linkedFrom: ReadonlyArray<Backlink>, h: HtmlBuilder<M>): Html =>
  Array.match(linkedFrom, {
    onEmpty: () => h.empty,
    onNonEmpty: (nonEmpty) =>
      h.div(
        [h.Class("mt-2 text-xs")],
        [
          h.p([], ["Can't delete: linked from"]),
          h.ul(
            [h.Class("mt-1 space-y-1"), h.AriaLabel("Linked from")],
            Array.map(nonEmpty, (backlink) =>
              h.keyed("li")(
                `${backlink.source}:${backlink.path}`,
                [h.Class("flex flex-wrap items-center gap-x-2")],
                [
                  entityLink(backlink.source, h, { className: "text-destructive underline" }),
                  h.span([], [`(${backlink.type}, at ${backlink.path})`]),
                ],
              ),
            ),
          ),
        ],
      ),
  });

const conflictList = <M>(conflicts: ReadonlyArray<UniqueConflict>, h: HtmlBuilder<M>): Html =>
  Array.match(conflicts, {
    onEmpty: () => h.empty,
    onNonEmpty: (nonEmpty) =>
      h.ul(
        [h.Class("mt-2 space-y-1 text-xs"), h.AriaLabel("Taken keys")],
        Array.map(nonEmpty, (conflict) =>
          h.keyed("li")(
            `${conflict.index}:${conflict.key}`,
            [h.Class("flex flex-wrap items-center gap-x-2")],
            [
              h.code([h.Class("font-mono font-semibold")], [conflict.index]),
              h.code([h.Class("font-mono")], [conflict.key]),
              Option.match(conflict.id, {
                onNone: () => h.span([], ["is taken"]),
                onSome: (id) =>
                  h.span(
                    [h.Class("flex items-center gap-1")],
                    ["is taken by", entityLink(id, h, { className: "text-destructive underline" })],
                  ),
              }),
            ],
          ),
        ),
      ),
  });

/** An API failure: its message, error code, and any located issues or link details. */
export const failureAlert = <M>(failure: ApiFailure, h: HtmlBuilder<M>): Html =>
  h.div(
    [h.Class(alertClass), h.Role("alert")],
    [
      h.div(
        [h.Class("flex flex-wrap items-center gap-2")],
        [
          h.span([h.Class("font-medium")], [failure.error]),
          Option.match(failure.code, {
            onNone: () => h.empty,
            onSome: (code) => badge({ variant: "destructive", className: "font-mono" }, [code], h),
          }),
        ],
      ),
      issueList(failure.issues, h),
      problemList(failure.problems, h),
      linkedFromList(failure.linkedFrom, h),
      conflictList(failure.conflicts, h),
    ],
  );

export const successAlert = <M>(children: ReadonlyArray<Html | string>, h: HtmlBuilder<M>): Html =>
  h.div(
    [h.Class("rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm"), h.Role("status")],
    children,
  );
