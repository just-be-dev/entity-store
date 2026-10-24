import * as Array from "effect/Array";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import * as String from "effect/String";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { confirmDialog } from "@/components/confirm";
import * as EntityForm from "@/components/entityForm/main";
import { failureAlert, successAlert } from "@/components/feedback";
import { jsonBlock } from "@/components/json";
import { pageHeader, section, statusText } from "@/components/layout";
import { entityLink, preview } from "@/components/links";
import { selectField, versionOptions } from "@/components/select";
import * as TypeForm from "@/components/typeForm/main";
import { badge } from "@/components/ui/badge";
import { button, buttonClass } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { input } from "@/components/ui/input";
import { type FormField, InputKind, cellText, formFields } from "@/domain/entityDraft";
import type {
  Entity,
  Included,
  IndexInfo,
  ProjectionFailure,
  TypeInfo,
  VersionInfo,
} from "@/domain/entityStore";
import { readyIndexes } from "@/domain/indexes";
import { asObject } from "@/domain/json";
import { linkedTypes, outgoingLinks } from "@/domain/links";
import { entityTitle } from "@/domain/title";
import { decodeSchema } from "@/domain/typeDraft";
import { formatTime, plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AppRoute, href } from "@/route";
import {
  Entities,
  Indexes,
  LOOKUP_LIMIT,
  Lookup,
  Message,
  type Model,
  type More,
  Precheck,
  TypeState,
  versionInfo,
} from "./main.ts";

// VIEW

const versionItem = (info: VersionInfo, h: HtmlBuilder<Message>): Html =>
  h.keyed("li")(
    `${info.version}`,
    [h.Class("rounded-lg border border-border")],
    [
      h.details(
        [h.Class("group")],
        [
          h.summary(
            [
              h.Class(
                "flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm hover:bg-muted/50",
              ),
            ],
            [
              badge({ variant: "secondary" }, [`v${info.version}`], h),
              h.span(
                [h.Class("min-w-0 flex-1 truncate")],
                [info.note || (info.version === 1 ? "Initial schema" : "No note")],
              ),
              Array.match(linkedTypes(info.schema), {
                onEmpty: () => h.empty,
                onNonEmpty: (types) =>
                  h.span(
                    [h.Class("font-mono text-xs text-muted-foreground")],
                    [`links → ${types.join(", ")}`],
                  ),
              }),
              h.span(
                [h.Class("font-mono text-xs text-muted-foreground")],
                [formatTime(info.createdAt)],
              ),
            ],
          ),
          h.div(
            [h.Class("grid gap-3 border-t border-border p-3 lg:grid-cols-2")],
            [
              h.div(
                [h.Class("min-w-0 space-y-1")],
                [
                  h.h4([h.Class("text-xs font-medium text-muted-foreground")], ["Schema"]),
                  jsonBlock(info.schema, h, { label: `Schema v${info.version}` }),
                ],
              ),
              Option.match(info.lens, {
                onNone: () => h.empty,
                onSome: (lens) =>
                  h.div(
                    [h.Class("min-w-0 space-y-1")],
                    [
                      h.h4(
                        [h.Class("text-xs font-medium text-muted-foreground")],
                        [`Lens v${info.version - 1} → v${info.version}`],
                      ),
                      jsonBlock(lens, h, { label: `Lens to v${info.version}` }),
                    ],
                  ),
              }),
            ],
          ),
        ],
      ),
    ],
  );

const versionsView = (info: TypeInfo, h: HtmlBuilder<Message>): Html =>
  section(
    {
      title: "Schema versions",
      actions: [
        h.a(
          [
            h.Href(href(AppRoute.NewVersion({ name: info.name }))),
            h.Class(buttonClass({ size: "sm" })),
          ],
          ["New version"],
        ),
      ],
    },
    [
      h.ul(
        [h.Class("space-y-2")],
        Array.map(Array.reverse(info.versions), (version) => versionItem(version, h)),
      ),
    ],
    h,
  );

const failuresView = (failures: ReadonlyArray<ProjectionFailure>, h: HtmlBuilder<Message>): Html =>
  Array.match(failures, {
    onEmpty: () => h.empty,
    onNonEmpty: (nonEmpty) =>
      h.div(
        [
          h.Class("rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm"),
          h.Role("alert"),
        ],
        [
          h.p(
            [h.Class("font-medium text-destructive")],
            [`${plural(nonEmpty.length, "entity")} couldn't be shown at this version`],
          ),
          h.ul(
            [h.Class("mt-2 space-y-1 text-xs")],
            Array.map(nonEmpty, (failure) =>
              h.keyed("li")(
                failure.id,
                [],
                [
                  h.a(
                    [
                      h.Href(href(AppRoute.EntityDetail({ id: failure.id }))),
                      h.Class("font-mono underline-offset-4 hover:underline"),
                    ],
                    [failure.id],
                  ),
                  ` (rev ${failure.rev}, stored v${failure.storedVersion}): ${failure.error}`,
                ],
              ),
            ),
          ),
        ],
      ),
  });

const moreView = (nextCursor: Option.Option<string>, more: More, h: HtmlBuilder<Message>): Html =>
  Option.match(nextCursor, {
    onNone: () => h.empty,
    onSome: () =>
      h.div(
        [h.Class("flex flex-wrap items-center gap-3")],
        [
          button(
            {
              type: "button",
              variant: "outline",
              size: "sm",
              onClick: Message.ClickedLoadMore(),
              isDisabled: more._tag === "Loading",
            },
            more._tag === "Loading" ? "Loading…" : "Load more",
            h,
          ),
          more._tag === "Failed" ? failureAlert(more.failure, h) : h.empty,
        ],
      ),
  });
const selectedIndex = (model: Model, ready: ReadonlyArray<IndexInfo>): Option.Option<IndexInfo> =>
  Option.flatMap(model.lookupIndex, (name) => Array.findFirst(ready, (i) => i.name === name));

/** Find entities by a ready index's key. Hidden until the type has one. */
const lookupForm = (model: Model, h: HtmlBuilder<Message>): Html =>
  Indexes.match(model.indexes, {
    Loading: () => h.empty,
    Failed: () => h.empty,
    Loaded: ({ items }) =>
      Array.match(readyIndexes(items), {
        onEmpty: () => h.empty,
        onNonEmpty: (ready) =>
          h.form(
            [
              h.OnSubmit(Message.SubmittedLookup()),
              h.Class("space-y-1 rounded-lg border border-border bg-muted/30 p-3"),
              h.AriaLabel("Find by index"),
              h.Role("search"),
            ],
            [
              h.div(
                [h.Class("flex flex-wrap items-end gap-3")],
                [
                  selectField(
                    {
                      id: "lookup-index",
                      label: "Find by",
                      value: Option.getOrElse(model.lookupIndex, () => ""),
                      options: Array.map(ready, (index) => ({
                        value: index.name,
                        label: index.name,
                      })),
                      onChange: (name) => Message.SelectedLookupIndex({ name }),
                    },
                    h,
                  ),
                  input(
                    {
                      id: "lookup-key",
                      label: "Key",
                      value: model.lookupKey,
                      placeholder: "exact key",
                      onInput: (value) => Message.UpdatedLookupKey({ value }),
                      className: "font-mono",
                      wrapperClass: "max-w-sm flex-1",
                    },
                    h,
                  ),
                  button(
                    {
                      type: "submit",
                      size: "sm",
                      isDisabled: String.isEmpty(model.lookupKey),
                    },
                    "Find",
                    h,
                  ),
                  model.lookup._tag === "Off"
                    ? h.empty
                    : button(
                        {
                          type: "button",
                          variant: "ghost",
                          size: "sm",
                          onClick: Message.ClickedClearLookup(),
                        },
                        "Show all",
                        h,
                      ),
                ],
              ),
              Option.match(selectedIndex(model, ready), {
                onNone: () => h.empty,
                onSome: (index) =>
                  h.p(
                    [h.Class("text-xs text-muted-foreground")],
                    [
                      "Matches ",
                      h.code([h.Class("font-mono")], [index.key]),
                      ` at v${index.version} exactly${index.unique ? " (unique)" : ""}.`,
                    ],
                  ),
              }),
            ],
          ),
      }),
  });

const indexesSummary = (model: Model, info: TypeInfo, h: HtmlBuilder<Message>): Html =>
  section(
    {
      title: "Indexes",
      actions: [
        h.a(
          [
            h.Href(href(AppRoute.TypeIndexes({ name: info.name }))),
            h.Class(buttonClass({ variant: "outline", size: "sm" })),
          ],
          ["Manage indexes"],
        ),
      ],
    },
    [
      Indexes.match(model.indexes, {
        Loading: () => statusText("Loading indexes…", h),
        Failed: ({ failure }) => failureAlert(failure, h),
        Loaded: ({ items }) =>
          Array.match(items, {
            onEmpty: () =>
              h.p(
                [h.Class("text-sm text-muted-foreground")],
                ["No indexes. Add one to look entities up by a field, like email."],
              ),
            onNonEmpty: (indexes) =>
              h.ul(
                [h.Class("flex flex-wrap gap-2"), h.AriaLabel("Index summary")],
                Array.map(indexes, (index) =>
                  h.keyed("li")(
                    index.name,
                    [
                      h.Class(
                        "flex items-center gap-2 rounded-lg border border-border px-2 py-1 text-xs",
                      ),
                    ],
                    [
                      h.span([h.Class("font-mono font-semibold")], [index.name]),
                      h.code([h.Class("font-mono text-muted-foreground")], [index.key]),
                      index.state === "ready"
                        ? h.empty
                        : badge(
                            { variant: index.state === "failed" ? "destructive" : "outline" },
                            [index.state],
                            h,
                          ),
                    ],
                  ),
                ),
              ),
          }),
      }),
    ],
    h,
  );

type EmptyText = Readonly<{ title: string; description: string }>;

const noEntities: EmptyText = {
  title: "No entities",
  description: "Create one with the form below.",
};

/** The form's fields for a version, or none when its schema doesn't decode. */
const columnsOf = (schema: Option.Option<VersionInfo>): ReadonlyArray<FormField> =>
  Option.match(
    Option.flatMap(schema, (info) => decodeSchema(info.schema)),
    {
      onNone: () => [],
      onSome: formFields,
    },
  );

const fieldOf = (data: Schema.Json, name: string): unknown =>
  Option.match(asObject(data), { onNone: () => undefined, onSome: (object) => object[name] });

const linkTarget = (input: InputKind): string =>
  InputKind.match(input, {
    Text: () => "entity",
    Number: () => "entity",
    Boolean: () => "entity",
    Date: () => "entity",
    DateTime: () => "entity",
    Choice: () => "entity",
    Json: () => "entity",
    Link: ({ to }) => to,
  });

const linkTitle = (target: string, targetType: string, included: Included) =>
  Option.match(Option.fromNullishOr(included[target]), {
    onNone: () => `${targetType} not found`,
    onSome: (entity) => `${entity.type}: ${preview(entity)}`,
  });

const textCell = (field: FormField, value: unknown, h: HtmlBuilder<Message>): Html =>
  h.span(
    [
      h.Class(
        cn(
          "block max-w-[16rem] truncate",
          field.input._tag === "Json" ? "font-mono text-xs" : undefined,
        ),
      ),
      h.Title(cellText(field, value)),
    ],
    [cellText(field, value)],
  );

const cell = (
  field: FormField,
  entity: Entity,
  schema: Schema.Json,
  included: Included,
  h: HtmlBuilder<Message>,
): Html => {
  const value = fieldOf(entity.data, field.name);
  if (value === undefined || value === null) {
    return h.span([h.Class("text-muted-foreground"), h.AriaLabel("Not set")], ["—"]);
  }
  if (field.input._tag === "Link" && typeof value === "string") {
    return entityLink(value, h, {
      title: linkTitle(value, linkTarget(field.input), included),
    });
  }
  if (field.input._tag === "Json") {
    return Array.match(
      Array.filter(outgoingLinks(schema, entity.data), (link) => link.path.startsWith(field.name)),
      {
        onEmpty: () => textCell(field, value, h),
        onNonEmpty: (links) =>
          h.ul(
            [h.Class("flex flex-wrap gap-x-2 gap-y-0.5"), h.AriaLabel(`${field.name} links`)],
            Array.map(links, (link) =>
              h.keyed("li")(
                `${link.path}:${link.target}`,
                [],
                [
                  entityLink(link.target, h, {
                    title: linkTitle(link.target, link.targetType, included),
                  }),
                ],
              ),
            ),
          ),
      },
    );
  }
  return textCell(field, value, h);
};

const rowActions = (entity: Entity, label: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("flex justify-end gap-1")],
    [
      button(
        {
          type: "button",
          variant: "ghost",
          size: "xs",
          onClick: Message.ClickedEditRow({ id: entity.id }),
          attributes: [h.AriaLabel(`Edit ${label}`)],
        },
        "Edit",
        h,
      ),
      button(
        {
          type: "button",
          variant: "ghost",
          size: "xs",
          onClick: Message.ClickedDeleteRow({ id: entity.id }),
          attributes: [h.AriaLabel(`Delete ${label}`), h.Class("text-destructive")],
        },
        "Delete",
        h,
      ),
    ],
  );

const entityRow = (
  entity: Entity,
  schema: Option.Option<VersionInfo>,
  columns: ReadonlyArray<FormField>,
  included: Included,
  h: HtmlBuilder<Message>,
): Html => {
  const title = Option.flatMap(schema, (version) => entityTitle(version.schema, entity.data));
  return h.keyed("tr")(
    entity.id,
    [h.Class("border-t border-border align-top")],
    [
      h.td(
        [h.Class("py-2 pr-4")],
        [
          ...Option.match(title, {
            onNone: () => [],
            onSome: (text) => [h.div([h.Class("text-sm font-medium")], [text])],
          }),
          h.a(
            [
              h.Href(href(AppRoute.EntityDetail({ id: entity.id }))),
              h.Class("font-mono text-xs text-primary underline-offset-4 hover:underline"),
            ],
            [entity.id],
          ),
        ],
      ),
      ...Array.map(columns, (field) =>
        h.td(
          [h.Class("py-2 pr-4 text-sm")],
          [
            cell(
              field,
              entity,
              Option.match(schema, { onNone: () => ({}), onSome: (info) => info.schema }),
              included,
              h,
            ),
          ],
        ),
      ),
      h.td([h.Class("py-2 pr-4 font-mono text-xs")], [`${entity.rev}`]),
      h.td([h.Class("py-2 pr-4 font-mono text-xs")], [`v${entity.storedVersion}`]),
      h.td(
        [
          h.Class(
            "hidden whitespace-nowrap py-2 pr-4 font-mono text-xs text-muted-foreground md:table-cell",
          ),
        ],
        [formatTime(entity.updatedAt)],
      ),
      h.td(
        [h.Class("py-1.5")],
        [
          rowActions(
            entity,
            Option.getOrElse(title, () => entity.id),
            h,
          ),
        ],
      ),
    ],
  );
};

const entitiesTable = (
  items: ReadonlyArray<Entity>,
  schema: Option.Option<VersionInfo>,
  included: Included,
  h: HtmlBuilder<Message>,
  empty: EmptyText = noEntities,
): Html =>
  Array.match(items, {
    onEmpty: () =>
      Empty(
        { className: "border border-border" },
        [
          Empty.header(
            {},
            [Empty.title({}, [empty.title], h), Empty.description({}, [empty.description], h)],
            h,
          ),
        ],
        h,
      ),
    onNonEmpty: (entities) => {
      const columns = columnsOf(schema);
      return h.div(
        [h.Class("overflow-x-auto")],
        [
          h.table(
            [h.Class("w-full text-left text-sm"), h.AriaLabel("Entities")],
            [
              h.thead(
                [h.Class("text-xs text-muted-foreground")],
                [
                  h.tr(
                    [],
                    [
                      h.th([h.Class("pb-2 pr-4 font-medium"), h.Scope("col")], ["ID"]),
                      ...Array.map(columns, (field) =>
                        h.th(
                          [h.Class("whitespace-nowrap pb-2 pr-4 font-medium"), h.Scope("col")],
                          [field.label === field.name ? field.name : `${field.label}`],
                        ),
                      ),
                      h.th([h.Class("pb-2 pr-4 font-medium"), h.Scope("col")], ["Rev"]),
                      h.th([h.Class("pb-2 pr-4 font-medium"), h.Scope("col")], ["Stored"]),
                      h.th(
                        [h.Class("hidden pb-2 pr-4 font-medium md:table-cell"), h.Scope("col")],
                        ["Updated"],
                      ),
                      h.th(
                        [h.Class("pb-2 font-medium"), h.Scope("col")],
                        [h.span([h.Class("sr-only")], ["Actions"])],
                      ),
                    ],
                  ),
                ],
              ),
              h.tbody(
                [],
                Array.map(entities, (entity) => entityRow(entity, schema, columns, included, h)),
              ),
            ],
          ),
        ],
      );
    },
  });

const rowEditorView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(model.maybeRowEditor, {
    onNone: () => h.empty,
    onSome: (form) =>
      h.div(
        [
          h.Class("space-y-3 rounded-lg border border-border bg-muted/30 p-3"),
          h.Role("region"),
          h.AriaLabel(`Editing ${form.idText}`),
        ],
        [
          h.p(
            [h.Class("text-sm font-medium")],
            ["Editing ", h.span([h.Class("font-mono")], [form.idText]), ` as v${form.version}`],
          ),
          h.submodel({
            slotId: "row-editor",
            model: form,
            view: EntityForm.view,
            toParentMessage: (message) => Message.GotRowEditorMessage({ message }),
          }),
        ],
      ),
  });

const noticeView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(model.maybeNotice, {
    onNone: () => h.empty,
    onSome: (notice) =>
      successAlert(
        [
          h.span([h.Class("flex-1")], [notice]),
          button(
            {
              type: "button",
              variant: "ghost",
              size: "xs",
              onClick: Message.ClickedDismissNotice(),
            },
            "Dismiss",
            h,
          ),
        ],
        h,
      ),
  });

const entitiesView = (model: Model, info: TypeInfo, h: HtmlBuilder<Message>): Html =>
  section(
    {
      title: "Entities",
      actions: [
        selectField(
          {
            id: "read-version",
            label: "Read as",
            value: `${Option.getOrElse(model.readVersion, () => info.latestVersion)}`,
            options: versionOptions(info.latestVersion),
            onChange: (value) => Message.SelectedReadVersion({ version: Number(value) }),
          },
          h,
        ),
      ],
    },
    [
      h.div(
        [h.Class("space-y-3")],
        [
          lookupForm(model, h),
          rowEditorView(model, h),
          Lookup.match(model.lookup, {
            Off: () => allEntitiesView(model, h),
            Loading: ({ index, key }) => statusText(`Looking up ${index} = "${key}"…`, h),
            Failed: ({ failure }) => failureAlert(failure, h),
            Loaded: ({ index, key, version, items, included, failures, nextCursor }) =>
              h.div(
                [h.Class("space-y-3")],
                [
                  entitiesTable(items, versionInfo(model, version), included, h, {
                    title: "No matches",
                    description: `No entity has ${index} = "${key}". Keys match exactly.`,
                  }),
                  failuresView(failures, h),
                  Option.isSome(nextCursor)
                    ? statusText(`Showing the first ${LOOKUP_LIMIT} matches.`, h)
                    : h.empty,
                ],
              ),
          }),
        ],
      ),
    ],
    h,
  );

const allEntitiesView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Entities.match(model.entities, {
    Idle: () => h.empty,
    Loading: () => statusText("Loading entities…", h),
    Failed: ({ failure }) => failureAlert(failure, h),
    Loaded: ({ version, items, failures, nextCursor, more, included }) =>
      h.div(
        [h.Class("space-y-3")],
        [
          entitiesTable(items, versionInfo(model, version), included, h),
          failuresView(failures, h),
          moreView(nextCursor, more, h),
        ],
      ),
  });

const newEntityView = (model: Model, info: TypeInfo, h: HtmlBuilder<Message>): Html =>
  section(
    {
      title: "New entity",
      actions: [
        selectField(
          {
            id: "write-version",
            label: "Write as",
            value: `${Option.getOrElse(model.writeVersion, () => info.latestVersion)}`,
            options: versionOptions(info.latestVersion),
            onChange: (value) => Message.SelectedWriteVersion({ version: Number(value) }),
          },
          h,
        ),
      ],
    },
    [
      Option.match(model.maybeNewEntity, {
        onNone: () => statusText("This version's schema can't be shown as a form.", h),
        onSome: (form) =>
          h.submodel({
            slotId: "new-entity",
            model: form,
            view: EntityForm.view,
            toParentMessage: (message) => Message.GotNewEntityMessage({ message }),
          }),
      }),
    ],
    h,
  );

const typeEditorView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(model.maybeTypeEditor, {
    onNone: () => h.empty,
    onSome: (form) =>
      section(
        { title: "Edit fields" },
        [
          h.div(
            [h.Class("space-y-3")],
            [
              h.submodel({
                slotId: "type-editor",
                model: form,
                view: TypeForm.view,
                toParentMessage: (message) => Message.GotTypeEditorMessage({ message }),
              }),
              Precheck.match(model.precheck, {
                Idle: () => h.empty,
                CheckingDelete: () => h.empty,
                CheckingVersion: () => statusText("Checking the generated lens…", h),
                Failed: ({ failure }) => failureAlert(failure, h),
              }),
            ],
          ),
        ],
        h,
      ),
  });

const headerActions = (model: Model, info: TypeInfo, h: HtmlBuilder<Message>) => [
  badge({ variant: "secondary" }, [`latest v${info.latestVersion}`], h),
  button(
    {
      type: "button",
      variant: "outline",
      size: "sm",
      onClick: Message.ClickedEditFields(),
      isDisabled: Option.isSome(model.maybeTypeEditor),
    },
    "Edit fields",
    h,
  ),
  button(
    {
      type: "button",
      variant: "destructive",
      size: "sm",
      onClick: Message.ClickedDeleteType(),
      isDisabled: model.precheck._tag === "CheckingDelete",
    },
    model.precheck._tag === "CheckingDelete" ? "Checking…" : "Delete type",
    h,
  ),
];

const loadedView = (model: Model, info: TypeInfo, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("space-y-6")],
    [
      pageHeader(
        {
          eyebrow: [
            h.a(
              [h.Href(href(AppRoute.TypeList())), h.Class("underline-offset-4 hover:underline")],
              ["Types"],
            ),
            " / ",
          ],
          title: info.name,
          description: info.description,
          actions: headerActions(model, info, h),
        },
        h,
      ),
      noticeView(model, h),
      model.precheck._tag === "Failed" && Option.isNone(model.maybeTypeEditor)
        ? failureAlert(model.precheck.failure, h)
        : h.empty,
      typeEditorView(model, h),
      entitiesView(model, info, h),
      newEntityView(model, info, h),
      indexesSummary(model, info, h),
      versionsView(info, h),
      confirmDialog(
        {
          dialog: model.dialog,
          maybeProposal: Option.map(model.maybePending, (pending) => pending.proposal),
          usage: model.usage,
          submission: model.submission,
          maybeChecking: Option.flatMap(model.maybePending, (pending) =>
            pending._tag === "DeleteEntity" && pending.links._tag === "Checking"
              ? Option.some("Checking who links to it…")
              : Option.none(),
          ),
          onConfirm: Message.ClickedConfirm(),
          toDialogMessage: (message) => Message.GotDialogMessage({ message }),
        },
        h,
      ),
    ],
  );

export const view = Submodel.defineView<Model, Message>((model, h): Html =>
  TypeState.match(model.type, {
    Loading: () => statusText(`Loading ${model.name}…`, h),
    Failed: ({ failure }) =>
      h.div(
        [h.Class("space-y-4")],
        [
          pageHeader({ title: model.name }, h),
          failureAlert(failure, h),
          h.a(
            [h.Href(href(AppRoute.TypeList())), h.Class(buttonClass({ variant: "outline" }))],
            ["All types"],
          ),
        ],
      ),
    Loaded: ({ info }) => loadedView(model, info, h),
  }),
);
