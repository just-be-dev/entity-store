import * as Array from "effect/Array";
import * as Option from "effect/Option";
import type { Html, HtmlBuilder } from "foldkit/html";
import { badge } from "@/components/ui/badge";
import type { ApiFailure, Issue } from "@/domain/entityStore";

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

/** An API failure: its message, error code, and any located issues. */
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
    ],
  );

export const successAlert = <M>(children: ReadonlyArray<Html | string>, h: HtmlBuilder<M>): Html =>
  h.div(
    [h.Class("rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm"), h.Role("status")],
    children,
  );
