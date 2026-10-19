import type { Html, HtmlBuilder } from "foldkit/html";
import { cn } from "@/lib/utils";

type Child = Html | string;

/** A titled card section. */
export const section = <M>(
  config: Readonly<{ title: string; actions?: ReadonlyArray<Child>; className?: string }>,
  children: ReadonlyArray<Child>,
  h: HtmlBuilder<M>,
): Html =>
  h.section(
    [
      h.Class(cn("rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5", config.className)),
      h.AriaLabel(config.title),
    ],
    [
      h.div(
        [h.Class("mb-4 flex flex-wrap items-center justify-between gap-3")],
        [
          h.h2([h.Class("text-base font-semibold tracking-tight")], [config.title]),
          h.div([h.Class("flex flex-wrap items-center gap-2")], config.actions ?? []),
        ],
      ),
      ...children,
    ],
  );

/** Page title row with an optional eyebrow and trailing actions. */
export const pageHeader = <M>(
  config: Readonly<{
    eyebrow?: ReadonlyArray<Child>;
    title: string;
    description?: string;
    actions?: ReadonlyArray<Child>;
  }>,
  h: HtmlBuilder<M>,
): Html =>
  h.header(
    [h.Class("flex flex-wrap items-end justify-between gap-4")],
    [
      h.div(
        [h.Class("min-w-0 space-y-1")],
        [
          config.eyebrow === undefined
            ? h.empty
            : h.p([h.Class("font-mono text-xs text-muted-foreground")], config.eyebrow),
          h.h1([h.Class("truncate text-2xl font-semibold tracking-tight")], [config.title]),
          config.description === undefined || config.description === ""
            ? h.empty
            : h.p([h.Class("text-sm text-muted-foreground")], [config.description]),
        ],
      ),
      h.div([h.Class("flex flex-wrap items-center gap-2")], config.actions ?? []),
    ],
  );

/** A muted status line, announced politely to screen readers. */
export const statusText = <M>(text: string, h: HtmlBuilder<M>): Html =>
  h.p([h.Class("text-sm text-muted-foreground"), h.Role("status")], [text]);

/** Label/value pairs in a compact grid. */
export const facts = <M>(
  entries: ReadonlyArray<readonly [string, Child]>,
  h: HtmlBuilder<M>,
): Html =>
  h.dl(
    [h.Class("grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm")],
    entries.flatMap(([label, value]) => [
      h.dt([h.Class("text-muted-foreground")], [label]),
      h.dd([h.Class("min-w-0 truncate font-mono text-xs leading-5")], [value]),
    ]),
  );
