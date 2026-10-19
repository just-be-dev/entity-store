import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as String from "effect/String";
import { Command, Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";
import type * as Update from "foldkit/update";
import { apiUrl, getJson, postJson, segment } from "@/api";
import { errorAlert, failureAlert, successAlert } from "@/components/feedback";
import { jsonBlock } from "@/components/json";
import { pageHeader, section, statusText } from "@/components/layout";
import { selectField, versionOptions } from "@/components/select";
import { badge } from "@/components/ui/badge";
import { button, buttonClass } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { input } from "@/components/ui/input";
import { textarea } from "@/components/ui/textarea";
import {
  ApiFailure,
  Entity,
  EntityPage,
  Included,
  ProjectionFailure,
  TypeInfo,
  type VersionInfo,
} from "@/domain/entityStore";
import { compactJson, exampleDocument, parseJson, prettyJson } from "@/domain/json";
import { linkedTypes, type OutgoingLink, outgoingLinks } from "@/domain/links";
import { entityLink, preview } from "@/components/links";
import { formatTime, plural } from "@/lib/format";
import { AppRoute, href } from "@/route";

// MODEL

export const TypeState = defineTaggedUnion({
  Loading: {},
  Failed: { failure: ApiFailure },
  Loaded: { info: TypeInfo },
});
export type TypeState = typeof TypeState.Type;

export const More = defineTaggedUnion({
  Idle: {},
  Loading: {},
  Failed: { failure: ApiFailure },
});
export type More = typeof More.Type;

export const Entities = defineTaggedUnion({
  Idle: {},
  Loading: { version: Schema.Int },
  Failed: { version: Schema.Int, failure: ApiFailure },
  Loaded: {
    version: Schema.Int,
    items: Schema.Array(Entity),
    included: Included,
    failures: Schema.Array(ProjectionFailure),
    nextCursor: Schema.Option(Schema.String),
    more: More,
  },
});
export type Entities = typeof Entities.Type;

export const Creation = defineTaggedUnion({
  Idle: {},
  Submitting: {},
  Invalid: { message: Schema.String },
  Failed: { failure: ApiFailure },
  Created: { id: Schema.String },
});
export type Creation = typeof Creation.Type;

export const Model = Schema.Struct({
  name: Schema.String,
  type: TypeState,
  readVersion: Schema.Option(Schema.Int),
  entities: Entities,
  writeVersion: Schema.Option(Schema.Int),
  idText: Schema.String,
  dataText: Schema.String,
  dataTemplate: Schema.String,
  creation: Creation,
});
export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  SucceededFetchType: { info: TypeInfo },
  FailedFetchType: { failure: ApiFailure },
  SelectedReadVersion: { version: Schema.Int },
  SucceededFetchEntities: { version: Schema.Int, page: EntityPage },
  FailedFetchEntities: { version: Schema.Int, failure: ApiFailure },
  ClickedLoadMore: {},
  SucceededFetchMoreEntities: { version: Schema.Int, page: EntityPage },
  FailedFetchMoreEntities: { version: Schema.Int, failure: ApiFailure },
  SelectedWriteVersion: { version: Schema.Int },
  UpdatedEntityId: { value: Schema.String },
  UpdatedEntityData: { value: Schema.String },
  SubmittedNewEntity: {},
  SucceededCreateEntity: { entity: Entity },
  FailedCreateEntity: { failure: ApiFailure },
});
export type Message = typeof Message.Type;

// COMMAND

export const FetchType = Command.define("FetchType", {
  args: { name: Schema.String },
  messages: [Message.SucceededFetchType, Message.FailedFetchType],
  execute: ({ name }) =>
    getJson(apiUrl(`types/${segment(name)}`), TypeInfo).pipe(
      Effect.map((info) => Message.SucceededFetchType({ info })),
      Effect.catch((failure) => Effect.succeed(Message.FailedFetchType({ failure }))),
    ),
});

const entitiesUrl = (name: string, version: number, cursor: Option.Option<string>) =>
  apiUrl(`types/${segment(name)}/entities`, {
    version: `${version}`,
    limit: "50",
    include: "links",
    ...Option.match(cursor, { onNone: () => ({}), onSome: (value) => ({ cursor: value }) }),
  });

export const FetchEntities = Command.define("FetchEntities", {
  args: { name: Schema.String, version: Schema.Int },
  messages: [Message.SucceededFetchEntities, Message.FailedFetchEntities],
  execute: ({ name, version }) =>
    getJson(entitiesUrl(name, version, Option.none()), EntityPage).pipe(
      Effect.map((page) => Message.SucceededFetchEntities({ version, page })),
      Effect.catch((failure) => Effect.succeed(Message.FailedFetchEntities({ version, failure }))),
    ),
});

export const FetchMoreEntities = Command.define("FetchMoreEntities", {
  args: { name: Schema.String, version: Schema.Int, cursor: Schema.String },
  messages: [Message.SucceededFetchMoreEntities, Message.FailedFetchMoreEntities],
  execute: ({ name, version, cursor }) =>
    getJson(entitiesUrl(name, version, Option.some(cursor)), EntityPage).pipe(
      Effect.map((page) => Message.SucceededFetchMoreEntities({ version, page })),
      Effect.catch((failure) =>
        Effect.succeed(Message.FailedFetchMoreEntities({ version, failure })),
      ),
    ),
});

export const CreateEntity = Command.define("CreateEntity", {
  args: {
    name: Schema.String,
    version: Schema.Int,
    id: Schema.Option(Schema.String),
    data: Schema.Json,
  },
  messages: [Message.SucceededCreateEntity, Message.FailedCreateEntity],
  execute: ({ name, version, id, data }) =>
    postJson(
      apiUrl(`types/${segment(name)}/entities`),
      Option.match(id, {
        onNone: () => ({ version, data }),
        onSome: (value) => ({ id: value, version, data }),
      }),
      Entity,
    ).pipe(
      Effect.map((entity) => Message.SucceededCreateEntity({ entity })),
      Effect.catch((failure) => Effect.succeed(Message.FailedCreateEntity({ failure }))),
    ),
});

// INIT

export const init = (name: string): Update.Return<Model, Message> => ({
  model: Model.make({
    name,
    type: TypeState.Loading(),
    readVersion: Option.none(),
    entities: Entities.Idle(),
    writeVersion: Option.none(),
    idText: "",
    dataText: "{}",
    dataTemplate: "{}",
    creation: Creation.Idle(),
  }),
  commands: [FetchType({ name })],
});

// UPDATE

type UpdateReturn = Update.Return<Model, Message>;

const versionInfo = (model: Model, version: number): Option.Option<VersionInfo> =>
  TypeState.match(model.type, {
    Loading: () => Option.none(),
    Failed: () => Option.none(),
    Loaded: ({ info }) => Array.findFirst(info.versions, (v) => v.version === version),
  });

const templateFor = (model: Model, version: number): string =>
  Option.match(versionInfo(model, version), {
    onNone: () => "{}",
    onSome: (info) => prettyJson(exampleDocument(info.schema)),
  });

const isCurrentVersion = (model: Model, version: number) =>
  Option.contains(model.readVersion, version);

const loadEntities = (model: Model, version: number): UpdateReturn => ({
  model: modifyFields(model, {
    readVersion: () => Option.some(version),
    entities: () => Entities.Loading({ version }),
  }),
  commands: [FetchEntities({ name: model.name, version })],
});

/** The loaded list, if it is still showing `version`. */
type LoadedEntities = Extract<Entities, { readonly _tag: "Loaded" }>;

const loadedAt = (model: Model, version: number): Option.Option<LoadedEntities> =>
  Entities.match<Option.Option<LoadedEntities>>(model.entities, {
    Idle: () => Option.none(),
    Loading: () => Option.none(),
    Failed: () => Option.none(),
    Loaded: (loaded) => (loaded.version === version ? Option.some(loaded) : Option.none()),
  });

const withMore = (entities: Entities, more: More): Entities =>
  entities._tag === "Loaded" ? Entities.Loaded({ ...entities, more }) : entities;

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    SucceededFetchType: ({ info }) => {
      const loaded = modifyFields(model, {
        type: () => TypeState.Loaded({ info }),
        writeVersion: () => Option.some(info.latestVersion),
      });
      const template = templateFor(loaded, info.latestVersion);
      return loadEntities(
        modifyFields(loaded, { dataText: () => template, dataTemplate: () => template }),
        info.latestVersion,
      );
    },
    FailedFetchType: ({ failure }) => ({
      model: modifyFields(model, { type: () => TypeState.Failed({ failure }) }),
    }),
    SelectedReadVersion: ({ version }) => loadEntities(model, version),
    SucceededFetchEntities: ({ version, page }) =>
      isCurrentVersion(model, version)
        ? {
            model: modifyFields(model, {
              entities: () =>
                Entities.Loaded({
                  version,
                  items: page.items,
                  failures: page.failures,
                  included: page.included ?? {},
                  nextCursor: page.nextCursor,
                  more: More.Idle(),
                }),
            }),
          }
        : { model },
    FailedFetchEntities: ({ version, failure }) =>
      isCurrentVersion(model, version)
        ? { model: modifyFields(model, { entities: () => Entities.Failed({ version, failure }) }) }
        : { model },
    ClickedLoadMore: () =>
      Entities.match(model.entities, {
        Idle: () => ({ model }),
        Loading: () => ({ model }),
        Failed: () => ({ model }),
        Loaded: (loaded) =>
          Option.match(loaded.nextCursor, {
            onNone: () => ({ model }),
            onSome: (cursor) =>
              loaded.more._tag === "Loading"
                ? { model }
                : {
                    model: modifyFields(model, {
                      entities: (entities) => withMore(entities, More.Loading()),
                    }),
                    commands: [
                      FetchMoreEntities({ name: model.name, version: loaded.version, cursor }),
                    ],
                  },
          }),
      }),
    SucceededFetchMoreEntities: ({ version, page }) =>
      Option.match(loadedAt(model, version), {
        onNone: () => ({ model }),
        onSome: (loaded) => ({
          model: modifyFields(model, {
            entities: () =>
              Entities.Loaded({
                version,
                items: Array.appendAll(loaded.items, page.items),
                failures: Array.appendAll(loaded.failures, page.failures),
                included: { ...loaded.included, ...page.included },
                nextCursor: page.nextCursor,
                more: More.Idle(),
              }),
          }),
        }),
      }),
    FailedFetchMoreEntities: ({ version, failure }) =>
      Option.isSome(loadedAt(model, version))
        ? {
            model: modifyFields(model, {
              entities: (entities) => withMore(entities, More.Failed({ failure })),
            }),
          }
        : { model },
    SelectedWriteVersion: ({ version }) => {
      const template = templateFor(model, version);
      const untouched = model.dataText === model.dataTemplate;
      return {
        model: modifyFields(model, {
          writeVersion: () => Option.some(version),
          dataText: (text) => (untouched ? template : text),
          dataTemplate: (current) => (untouched ? template : current),
        }),
      };
    },
    UpdatedEntityId: ({ value }) => ({ model: modifyFields(model, { idText: () => value }) }),
    UpdatedEntityData: ({ value }) => ({ model: modifyFields(model, { dataText: () => value }) }),
    SubmittedNewEntity: () =>
      Option.match(model.writeVersion, {
        onNone: () => ({ model }),
        onSome: (version) => {
          if (model.creation._tag === "Submitting") {
            return { model };
          }
          return Result.match(parseJson(model.dataText), {
            onFailure: (error) => ({
              model: modifyFields(model, {
                creation: () => Creation.Invalid({ message: `Data isn't valid JSON: ${error}` }),
              }),
            }),
            onSuccess: (data) => ({
              model: modifyFields(model, { creation: () => Creation.Submitting() }),
              commands: [
                CreateEntity({
                  name: model.name,
                  version,
                  id: Option.liftPredicate(model.idText.trim(), String.isNonEmpty),
                  data,
                }),
              ],
            }),
          });
        },
      }),
    SucceededCreateEntity: ({ entity }) => {
      const created = modifyFields(model, {
        creation: () => Creation.Created({ id: entity.id }),
        idText: () => "",
        dataText: () => model.dataTemplate,
      });
      return Option.match(model.readVersion, {
        onNone: () => ({ model: created }),
        onSome: (version) => loadEntities(created, version),
      });
    },
    FailedCreateEntity: ({ failure }) => ({
      model: modifyFields(model, { creation: () => Creation.Failed({ failure }) }),
    }),
  });

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

const linkChips = (
  links: ReadonlyArray<OutgoingLink>,
  included: Included,
  h: HtmlBuilder<Message>,
): Html =>
  Array.match(links, {
    onEmpty: () => h.empty,
    onNonEmpty: (nonEmpty) =>
      h.ul(
        [h.Class("mt-1 flex flex-wrap gap-x-3 gap-y-0.5"), h.AriaLabel("Links")],
        Array.map(nonEmpty, (link) =>
          h.keyed("li")(
            `${link.path}:${link.target}`,
            [h.Class("flex items-baseline gap-1 text-xs")],
            [
              h.span([h.Class("font-mono text-muted-foreground")], [`${link.path} →`]),
              entityLink(link.target, h, {
                title: Option.match(Option.fromNullishOr(included[link.target]), {
                  onNone: () => `${link.targetType} not found`,
                  onSome: (target) => `${target.type}: ${preview(target)}`,
                }),
              }),
            ],
          ),
        ),
      ),
  });

const entityRow = (
  entity: Entity,
  schema: Option.Option<VersionInfo>,
  included: Included,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed("tr")(
    entity.id,
    [h.Class("border-t border-border align-top")],
    [
      h.td(
        [h.Class("py-2 pr-4")],
        [
          h.a(
            [
              h.Href(href(AppRoute.EntityDetail({ id: entity.id }))),
              h.Class("font-mono text-xs text-primary underline-offset-4 hover:underline"),
            ],
            [entity.id],
          ),
        ],
      ),
      h.td([h.Class("py-2 pr-4 font-mono text-xs")], [`${entity.rev}`]),
      h.td([h.Class("py-2 pr-4 font-mono text-xs")], [`v${entity.storedVersion}`]),
      h.td(
        [h.Class("max-w-0 py-2 pr-4 w-full")],
        [
          h.code(
            [
              h.Class("block truncate font-mono text-xs text-muted-foreground"),
              h.Title(compactJson(entity.data)),
            ],
            [compactJson(entity.data)],
          ),
          linkChips(
            Option.match(schema, {
              onNone: () => [],
              onSome: (version) => outgoingLinks(version.schema, entity.data),
            }),
            included,
            h,
          ),
        ],
      ),
      h.td(
        [
          h.Class(
            "hidden whitespace-nowrap py-2 font-mono text-xs text-muted-foreground md:table-cell",
          ),
        ],
        [formatTime(entity.updatedAt)],
      ),
    ],
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

const entitiesTable = (
  items: ReadonlyArray<Entity>,
  schema: Option.Option<VersionInfo>,
  included: Included,
  h: HtmlBuilder<Message>,
): Html =>
  Array.match(items, {
    onEmpty: () =>
      Empty(
        { className: "border border-border" },
        [
          Empty.header(
            {},
            [
              Empty.title({}, ["No entities"], h),
              Empty.description({}, ["Create one with the form below."], h),
            ],
            h,
          ),
        ],
        h,
      ),
    onNonEmpty: (entities) =>
      h.div(
        [h.Class("overflow-x-auto")],
        [
          h.table(
            [h.Class("w-full text-left text-sm")],
            [
              h.thead(
                [h.Class("text-xs text-muted-foreground")],
                [
                  h.tr(
                    [],
                    [
                      h.th([h.Class("pb-2 pr-4 font-medium"), h.Scope("col")], ["ID"]),
                      h.th([h.Class("pb-2 pr-4 font-medium"), h.Scope("col")], ["Rev"]),
                      h.th([h.Class("pb-2 pr-4 font-medium"), h.Scope("col")], ["Stored"]),
                      h.th([h.Class("pb-2 pr-4 font-medium"), h.Scope("col")], ["Data"]),
                      h.th(
                        [h.Class("hidden pb-2 font-medium md:table-cell"), h.Scope("col")],
                        ["Updated"],
                      ),
                    ],
                  ),
                ],
              ),
              h.tbody(
                [],
                Array.map(entities, (entity) => entityRow(entity, schema, included, h)),
              ),
            ],
          ),
        ],
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
      }),
    ],
    h,
  );

const creationView = (creation: Creation, h: HtmlBuilder<Message>): Html =>
  Creation.match(creation, {
    Idle: () => h.empty,
    Submitting: () => statusText("Creating entity…", h),
    Invalid: ({ message }) => errorAlert(message, h),
    Failed: ({ failure }) => failureAlert(failure, h),
    Created: ({ id }) =>
      successAlert(
        [
          "Created ",
          h.a(
            [
              h.Href(href(AppRoute.EntityDetail({ id }))),
              h.Class("font-mono text-primary underline-offset-4 hover:underline"),
            ],
            [id],
          ),
          ".",
        ],
        h,
      ),
  });

const newEntityView = (model: Model, info: TypeInfo, h: HtmlBuilder<Message>): Html =>
  section(
    { title: "New entity" },
    [
      h.form(
        [h.OnSubmit(Message.SubmittedNewEntity()), h.Class("space-y-4"), h.AriaLabel("New entity")],
        [
          h.div(
            [h.Class("flex flex-wrap items-end gap-4")],
            [
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
              input(
                {
                  id: "new-entity-id",
                  label: "ID (optional)",
                  value: model.idText,
                  placeholder: "Generated when blank",
                  onInput: (value) => Message.UpdatedEntityId({ value }),
                  className: "font-mono",
                  wrapperClass: "max-w-xs",
                },
                h,
              ),
            ],
          ),
          textarea(
            {
              id: "new-entity-data",
              label: "Data (JSON)",
              value: model.dataText,
              rows: 8,
              onInput: (value) => Message.UpdatedEntityData({ value }),
              className: "max-h-[28rem] font-mono text-xs",
            },
            h,
          ),
          creationView(model.creation, h),
          button(
            { type: "submit", isDisabled: model.creation._tag === "Submitting" },
            model.creation._tag === "Submitting" ? "Creating…" : "Create entity",
            h,
          ),
        ],
      ),
    ],
    h,
  );

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
          actions: [badge({ variant: "secondary" }, [`latest v${info.latestVersion}`], h)],
        },
        h,
      ),
      entitiesView(model, info, h),
      newEntityView(model, info, h),
      versionsView(info, h),
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
