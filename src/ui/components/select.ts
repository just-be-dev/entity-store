import * as Array from "effect/Array";
import type { Html, HtmlBuilder } from "foldkit/html";
import { inputLabelClass } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export const selectClass =
  "h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30";

export type SelectOption = Readonly<{ value: string; label: string }>;

/** A labelled native select. */
export const selectField = <M>(
  config: Readonly<{
    id: string;
    label: string;
    value: string;
    options: ReadonlyArray<SelectOption>;
    onChange: (value: string) => M;
    isDisabled?: boolean;
    className?: string;
  }>,
  h: HtmlBuilder<M>,
): Html =>
  h.div(
    [h.Class(cn("flex items-center gap-2", config.className))],
    [
      h.label([h.For(config.id), h.Class(inputLabelClass)], [config.label]),
      h.select(
        [
          h.Id(config.id),
          h.Class(selectClass),
          h.Value(config.value),
          h.OnChange(config.onChange),
          h.Disabled(config.isDisabled === true),
        ],
        Array.map(config.options, (option) =>
          h.keyed("option")(
            option.value,
            [h.Value(option.value), h.Selected(option.value === config.value)],
            [option.label],
          ),
        ),
      ),
    ],
  );

/** Schema versions 1..latest, newest first. */
export const versionOptions = (latest: number): ReadonlyArray<SelectOption> =>
  Array.map(Array.reverse(Array.range(1, Math.max(1, latest))), (version) => ({
    value: String(version),
    label: `v${version}${version === latest ? " (latest)" : ""}`,
  }));
