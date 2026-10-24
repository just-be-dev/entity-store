/**
 * Tells the hub shell what to list under Entities in the platform's one sidebar. The shapes are
 * the host↔shell protocol in agents' `docs/hub-shell.md`; keep them in step with it. They are
 * Schemas so the subscription that publishes the nav compares it structurally and republishes
 * only when it changes.
 */
import * as Array from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Box, type IconNode as LucideIconNode, Shapes } from "lucide";
import { type Model, NavTypes, Page } from "./main.ts";
import { AppRoute, href } from "./route.ts";

/** lucide's icon format: SVG children as `[tag, attributes]`, with string attribute values. */
export const IconNode = Schema.Array(
  Schema.Tuple([Schema.String, Schema.Record(Schema.String, Schema.String)]),
);
export type IconNode = typeof IconNode.Type;

export const HubNavLink = Schema.Struct({
  label: Schema.String,
  /** An absolute path on this origin or a full URL. */
  href: Schema.String,
  icon: Schema.optionalKey(IconNode),
  count: Schema.optionalKey(Schema.Finite),
  current: Schema.optionalKey(Schema.Boolean),
  mono: Schema.optionalKey(Schema.Boolean),
});
export type HubNavLink = typeof HubNavLink.Type;

export const HubNavAction = Schema.Struct({
  label: Schema.String,
  icon: IconNode,
  /** The id the shell hands back in a `hub:action` event. */
  action: Schema.String,
});
export type HubNavAction = typeof HubNavAction.Type;

export const HubNavGroup = Schema.Struct({
  label: Schema.optionalKey(Schema.String),
  action: Schema.optionalKey(HubNavAction),
  items: Schema.Array(HubNavLink),
  /** Shown in place of `items` when there are none. */
  note: Schema.optionalKey(Schema.String),
  noteTone: Schema.optionalKey(Schema.Literals(["muted", "error"])),
});
export type HubNavGroup = typeof HubNavGroup.Type;

export const HubNav = Schema.Struct({
  version: Schema.Literal(1),
  navigation: Schema.optionalKey(Schema.Literals(["history", "document"])),
  switcher: Schema.optionalKey(
    Schema.Struct({
      label: Schema.String,
      icon: Schema.optionalKey(IconNode),
      items: Schema.Array(HubNavLink),
      actions: Schema.optionalKey(Schema.Array(HubNavAction)),
    }),
  ),
  groups: Schema.Array(HubNavGroup),
});
export type HubNav = typeof HubNav.Type;

declare global {
  interface Window {
    hubNav?: HubNav;
  }
}

/** A lucide icon with its attribute values as strings, as the protocol carries them. */
export const iconOf = (node: LucideIconNode): IconNode =>
  Array.map(node, ([tag, attributes]) => [
    tag,
    Object.fromEntries(
      Array.flatMap(Object.entries(attributes), ([name, value]) =>
        value === undefined ? [] : [[name, `${value}`] as const],
      ),
    ),
  ]);

const typesIcon = iconOf(Shapes);
const typeIcon = iconOf(Box);

/** The type the open page is about: a type's own pages, or a loaded entity's type. */
export const currentTypeOf = (page: Page): Option.Option<string> =>
  Page.match(page, {
    TypeList: () => Option.none(),
    TypeDetail: ({ model }) => Option.some(model.name),
    NewVersion: ({ model }) => Option.some(model.name),
    TypeIndexes: ({ model }) => Option.some(model.name),
    EntityDetail: ({ model }) =>
      model.entity._tag === "Loaded" ? Option.some(model.entity.entity.type) : Option.none(),
    NotFound: () => Option.none(),
  });

const typesGroup = (model: Model): HubNavGroup => {
  const label = "Entity types";
  const currentType = currentTypeOf(model.page);
  return NavTypes.match<HubNavGroup>(model.navTypes, {
    Loading: () => ({ label, items: [], note: "Loading…", noteTone: "muted" }),
    Failed: ({ failure }) => ({
      label,
      items: [],
      note: `Couldn't load entity types: ${failure.error}`,
      noteTone: "error",
    }),
    Loaded: ({ names }) =>
      Array.match<string, HubNavGroup>(names, {
        onEmpty: () => ({ label, items: [], note: "No entity types yet.", noteTone: "muted" }),
        onNonEmpty: (listed) => ({
          label,
          items: Array.map(listed, (name) => ({
            label: name,
            href: href(AppRoute.TypeDetail({ name })),
            icon: typeIcon,
            mono: true,
            ...(Option.contains(currentType, name) ? { current: true } : {}),
          })),
        }),
      }),
  });
};

/** What Entities lists under its entry in the hub's sidebar, with the open page marked. */
export const hubNavOf = (model: Model): HubNav => ({
  version: 1,
  navigation: "history",
  groups: [
    {
      items: [
        {
          label: "All types",
          href: href(AppRoute.TypeList()),
          icon: typesIcon,
          ...(model.page._tag === "TypeList" ? { current: true } : {}),
        },
      ],
    },
    typesGroup(model),
  ],
});

/** Hands the shell `nav`: the global covers a shell that loads after the app. */
export const publishHubNav = (nav: HubNav): void => {
  window.hubNav = nav;
  window.dispatchEvent(new CustomEvent("hub:nav", { detail: nav }));
};
