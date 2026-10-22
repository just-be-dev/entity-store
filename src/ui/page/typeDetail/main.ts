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
  IndexInfo,
  IndexList,
  ProjectionFailure,
  TypeInfo,
  type VersionInfo,
} from "@/domain/entityStore";
import { compactJson, exampleDocument, parseJson, prettyJson } from "@/domain/json";
import { readyIndexes } from "@/domain/indexes";
import { linkedTypes, type OutgoingLink, outgoingLinks } from "@/domain/links";
import { entityTitle } from "@/domain/title";
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

export const Indexes = defineTaggedUnion({
  Loading: {},
  Failed: { failure: ApiFailure },
  Loaded: { items: Schema.Array(IndexInfo) },
});
export type Indexes = typeof Indexes.Type;

/** A lookup by index key, shown instead of the full entity list while active. */
export const Lookup = defineTaggedUnion({
  Off: {},
  Loading: { index: Schema.String, key: Schema.String, version: Schema.Int },
  Failed: { index: Schema.String, key: Schema.String, version: Schema.Int, failure: ApiFailure },
  Loaded: {
    index: Schema.String,
    key: Schema.String,
    version: Schema.Int,
    items: Schema.Array(Entity),
    included: Included,
    failures: Schema.Array(ProjectionFailure),
    nextCursor: Schema.Option(Schema.String),
  },
});
export type Lookup = typeof Lookup.Type;

export const Model = Schema.Struct({
  name: Schema.String,
  type: TypeState,
  readVersion: Schema.Option(Schema.Int),
  entities: Entities,
  indexes: Indexes,
  lookupIndex: Schema.Option(Schema.String),
  lookupKey: Schema.String,
  lookup: Lookup,
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
  SucceededFetchIndexes: { items: Schema.Array(IndexInfo) },
  FailedFetchIndexes: { failure: ApiFailure },
  SelectedLookupIndex: { name: Schema.String },
  UpdatedLookupKey: { value: Schema.String },
  SubmittedLookup: {},
  SucceededLookup: {
    index: Schema.String,
    key: Schema.String,
    version: Schema.Int,
    page: EntityPage,
  },
  FailedLookup: {
    index: Schema.String,
    key: Schema.String,
    version: Schema.Int,
    failure: ApiFailure,
  },
  ClickedClearLookup: {},
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

export const FetchIndexes = Command.define("FetchIndexes", {
  args: { name: Schema.String },
  messages: [Message.SucceededFetchIndexes, Message.FailedFetchIndexes],
  execute: ({ name }) =>
    getJson(apiUrl(`types/${segment(name)}/indexes`), IndexList).pipe(
      Effect.map(({ items }) => Message.SucceededFetchIndexes({ items })),
      Effect.catch((failure) => Effect.succeed(Message.FailedFetchIndexes({ failure }))),
    ),
});

/** Lookups show up to one full page; a unique index has at most one match. */
export const LOOKUP_LIMIT = 200;

export const LookUpEntities = Command.define("LookUpEntities", {
  args: { name: Schema.String, index: Schema.String, key: Schema.String, version: Schema.Int },
  messages: [Message.SucceededLookup, Message.FailedLookup],
  execute: ({ name, index, key, version }) =>
    getJson(
      apiUrl(`types/${segment(name)}/entities`, {
        index,
        eq: key,
        version: `${version}`,
        limit: `${LOOKUP_LIMIT}`,
        include: "links",
      }),
      EntityPage,
    ).pipe(
      Effect.map((page) => Message.SucceededLookup({ index, key, version, page })),
      Effect.catch((failure) =>
        Effect.succeed(Message.FailedLookup({ index, key, version, failure })),
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
    indexes: Indexes.Loading(),
    lookupIndex: Option.none(),
    lookupKey: "",
    lookup: Lookup.Off(),
    writeVersion: Option.none(),
    idText: "",
    dataText: "{}",
    dataTemplate: "{}",
    creation: Creation.Idle(),
  }),
  commands: [FetchType({ name }), FetchIndexes({ name })],
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

/** The active lookup's index and key, if any. */
const activeLookup = (lookup: Lookup): Option.Option<{ index: string; key: string }> =>
  Lookup.match<Option.Option<{ index: string; key: string }>>(lookup, {
    Off: () => Option.none(),
    Loading: ({ index, key }) => Option.some({ index, key }),
    Failed: ({ index, key }) => Option.some({ index, key }),
    Loaded: ({ index, key }) => Option.some({ index, key }),
  });

const lookUp = (model: Model, index: string, key: string, version: number): UpdateReturn => ({
  model: modifyFields(model, { lookup: () => Lookup.Loading({ index, key, version }) }),
  commands: [LookUpEntities({ name: model.name, index, key, version })],
});

const isPendingLookup = (model: Model, index: string, key: string, version: number) =>
  model.lookup._tag === "Loading" &&
  model.lookup.index === index &&
  model.lookup.key === key &&
  model.lookup.version === version;

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
    SelectedReadVersion: ({ version }) => {
      const reload = loadEntities(model, version);
      return Option.match(activeLookup(model.lookup), {
        onNone: () => reload,
        onSome: ({ index, key }) => {
          const relookup = lookUp(reload.model, index, key, version);
          return {
            model: relookup.model,
            commands: [...(reload.commands ?? []), ...(relookup.commands ?? [])],
          };
        },
      });
    },
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
    SucceededFetchIndexes: ({ items }) => {
      const ready = readyIndexes(items);
      return {
        model: modifyFields(model, {
          indexes: () => Indexes.Loaded({ items }),
          lookupIndex: (selected) =>
            Option.isSome(
              Option.filter(selected, (name) => Array.some(ready, (i) => i.name === name)),
            )
              ? selected
              : Option.map(Array.head(ready), (index) => index.name),
        }),
      };
    },
    FailedFetchIndexes: ({ failure }) => ({
      model: modifyFields(model, { indexes: () => Indexes.Failed({ failure }) }),
    }),
    SelectedLookupIndex: ({ name }) => ({
      model: modifyFields(model, { lookupIndex: () => Option.some(name) }),
    }),
    UpdatedLookupKey: ({ value }) => ({ model: modifyFields(model, { lookupKey: () => value }) }),
    SubmittedLookup: () =>
      Option.match(Option.all({ index: model.lookupIndex, version: model.readVersion }), {
        onNone: () => ({ model }),
        onSome: ({ index, version }) =>
          String.isEmpty(model.lookupKey)
            ? { model }
            : lookUp(model, index, model.lookupKey, version),
      }),
    SucceededLookup: ({ index, key, version, page }) =>
      isPendingLookup(model, index, key, version)
        ? {
            model: modifyFields(model, {
              lookup: () =>
                Lookup.Loaded({
                  index,
                  key,
                  version,
                  items: page.items,
                  included: page.included ?? {},
                  failures: page.failures,
                  nextCursor: page.nextCursor,
                }),
            }),
          }
        : { model },
    FailedLookup: ({ index, key, version, failure }) =>
      isPendingLookup(model, index, key, version)
        ? {
            model: modifyFields(model, {
              lookup: () => Lookup.Failed({ index, key, version, failure }),
            }),
          }
        : { model },
    ClickedClearLookup: () => ({ model: modifyFields(model, { lookup: () => Lookup.Off() }) }),
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
          ...Option.match(
            Option.flatMap(schema, (version) => entityTitle(version.schema, entity.data)),
            {
              onNone: () => [],
              onSome: (title) => [h.div([h.Class("text-sm font-medium")], [title])],
            },
          ),
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

type EmptyText = Readonly<{ title: string; description: string }>;

const noEntities: EmptyText = {
  title: "No entities",
  description: "Create one with the form below.",
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
      h.div(
        [h.Class("space-y-3")],
        [
          lookupForm(model, h),
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
      indexesSummary(model, info, h),
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
