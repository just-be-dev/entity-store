import type { Html, HtmlBuilder } from "foldkit/html";
import type { Entity } from "@/domain/entityStore";
import { compactJson } from "@/domain/json";
import { cn } from "@/lib/utils";
import { AppRoute, href } from "@/route";

/** An internal link to an entity's page, labelled with its id. */
export const entityLink = <M>(
  id: string,
  h: HtmlBuilder<M>,
  config: Readonly<{ className?: string; title?: string }> = {},
): Html =>
  h.a(
    [
      h.Href(href(AppRoute.EntityDetail({ id }))),
      h.Class(
        cn("font-mono text-xs text-primary underline-offset-4 hover:underline", config.className),
      ),
      ...(config.title === undefined ? [] : [h.Title(config.title)]),
    ],
    [id],
  );

const PREVIEW_LENGTH = 80;

/** A one-line glimpse of an entity's data. */
export const preview = (entity: Entity): string => {
  const json = compactJson(entity.data);
  return json.length > PREVIEW_LENGTH ? `${json.slice(0, PREVIEW_LENGTH - 1)}…` : json;
};
