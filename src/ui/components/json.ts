import type * as Schema from "effect/Schema";
import type { Html, HtmlBuilder } from "foldkit/html";
import { prettyJson } from "@/domain/json";
import { cn } from "@/lib/utils";

/** Pretty-printed, scrollable JSON. */
export const jsonBlock = <M>(
  value: Schema.Json,
  h: HtmlBuilder<M>,
  config: Readonly<{ label?: string; className?: string }> = {},
): Html =>
  h.pre(
    [
      h.Class(
        cn(
          "max-h-96 overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre",
          config.className,
        ),
      ),
      ...(config.label === undefined ? [] : [h.AriaLabel(config.label)]),
      h.Tabindex(0),
    ],
    [prettyJson(value)],
  );
