import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import * as String from "effect/String";
import { Command, Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";
import type * as Update from "foldkit/update";
import { apiUrl, deleteJson, getJson, postJson, segment } from "@/api";
import { errorAlert, failureAlert, successAlert } from "@/components/feedback";
import { pageHeader, section, statusText } from "@/components/layout";
import { selectField, versionOptions } from "@/components/select";
import { type BadgeVariant, badge } from "@/components/ui/badge";
import { button, buttonClass } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { input, inputDescriptionClass } from "@/components/ui/input";
import {
  ApiFailure,
  DroppedIndex,
  IndexInfo,
  IndexList,
  type IndexState,
  TypeInfo,
} from "@/domain/entityStore";
import { schemaFields } from "@/domain/indexes";
import { formatTime } from "@/lib/format";
import { AppRoute, href } from "@/route";

// MODEL

export const TypeState = defineTaggedUnion({
  Loading: {},
  Failed: { failure: ApiFailure },
  Loaded: { info: TypeInfo },
});
export type TypeState = typeof TypeState.Type;

export const Indexes = defineTaggedUnion({
  Loading: {},
  Failed: { failure: ApiFailure },
  Loaded: { items: Schema.Array(IndexInfo) },
});
export type Indexes = typeof Indexes.Type;

export const Creation = defineTaggedUnion({
  Idle: {},
  Invalid: { message: Schema.String },
  Submitting: {},
  Failed: { failure: ApiFailure },
  Created: { index: IndexInfo },
});
export type Creation = typeof Creation.Type;

/** What's happening to one existing index. One at a time. */
export const Action = defineTaggedUnion({
  Idle: {},
  ConfirmingDrop: { name: Schema.String },
  Dropping: { name: Schema.String },
  Building: { name: Schema.String },
  Failed: { name: Schema.String, failure: ApiFailure },
});
export type Action = typeof Action.Type;

export const Model = Schema.Struct({
  name: Schema.String,
  type: TypeState,
  indexes: Indexes,
  nameText: Schema.String,
  version: Schema.Option(Schema.Int),
  keyText: Schema.String,
  isUnique: Schema.Boolean,
  creation: Creation,
  action: Action,
});
export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  SucceededFetchType: { info: TypeInfo },
  FailedFetchType: { failure: ApiFailure },
  SucceededFetchIndexes: { items: Schema.Array(IndexInfo) },
  FailedFetchIndexes: { failure: ApiFailure },
  ClickedRefresh: {},
  UpdatedIndexName: { value: Schema.String },
  SelectedIndexVersion: { version: Schema.Int },
  UpdatedIndexKey: { value: Schema.String },
  ClickedUseField: { field: Schema.String },
  ToggledUnique: {},
  SubmittedNewIndex: {},
  SucceededCreateIndex: { index: IndexInfo },
  FailedCreateIndex: { failure: ApiFailure },
  ClickedDropIndex: { name: Schema.String },
  ClickedCancelDrop: {},
  ClickedConfirmDrop: { name: Schema.String },
  SucceededDropIndex: { name: Schema.String },
  FailedDropIndex: { name: Schema.String, failure: ApiFailure },
  ClickedBuildIndex: { name: Schema.String },
  SucceededBuildIndex: { index: IndexInfo },
  FailedBuildIndex: { name: Schema.String, failure: ApiFailure },
});
export type Message = typeof Message.Type;

// COMMAND

const indexesPath = (type: string) => `types/${segment(type)}/indexes`;
const indexPath = (type: string, name: string) => `${indexesPath(type)}/${segment(name)}`;

export const FetchType = Command.define("FetchType", {
  args: { name: Schema.String },
  messages: [Message.SucceededFetchType, Message.FailedFetchType],
  execute: ({ name }) =>
    getJson(apiUrl(`types/${segment(name)}`), TypeInfo).pipe(
      Effect.map((info) => Message.SucceededFetchType({ info })),
      Effect.catch((failure) => Effect.succeed(Message.FailedFetchType({ failure }))),
    ),
});

export const FetchIndexes = Command.define("FetchIndexes", {
  args: { name: Schema.String },
  messages: [Message.SucceededFetchIndexes, Message.FailedFetchIndexes],
  execute: ({ name }) =>
    getJson(apiUrl(indexesPath(name)), IndexList).pipe(
      Effect.map(({ items }) => Message.SucceededFetchIndexes({ items })),
      Effect.catch((failure) => Effect.succeed(Message.FailedFetchIndexes({ failure }))),
    ),
});

export const CreateIndex = Command.define("CreateIndex", {
  args: {
    type: Schema.String,
    name: Schema.String,
    version: Schema.Int,
    key: Schema.String,
    unique: Schema.Boolean,
  },
  messages: [Message.SucceededCreateIndex, Message.FailedCreateIndex],
  execute: ({ type, name, version, key, unique }) =>
    postJson(apiUrl(indexesPath(type)), { name, version, key, unique }, IndexInfo).pipe(
      Effect.map((index) => Message.SucceededCreateIndex({ index })),
      Effect.catch((failure) => Effect.succeed(Message.FailedCreateIndex({ failure }))),
    ),
});

export const DropIndex = Command.define("DropIndex", {
  args: { type: Schema.String, name: Schema.String },
  messages: [Message.SucceededDropIndex, Message.FailedDropIndex],
  execute: ({ type, name }) =>
    deleteJson(apiUrl(indexPath(type, name)), DroppedIndex).pipe(
      Effect.map(() => Message.SucceededDropIndex({ name })),
      Effect.catch((failure) => Effect.succeed(Message.FailedDropIndex({ name, failure }))),
    ),
});

export const BuildIndex = Command.define("BuildIndex", {
  args: { type: Schema.String, name: Schema.String },
  messages: [Message.SucceededBuildIndex, Message.FailedBuildIndex],
  execute: ({ type, name }) =>
    postJson(apiUrl(`${indexPath(type, name)}/build`), {}, IndexInfo).pipe(
      Effect.map((index) => Message.SucceededBuildIndex({ index })),
      Effect.catch((failure) => Effect.succeed(Message.FailedBuildIndex({ name, failure }))),
    ),
});

// INIT

export const init = (name: string): Update.Return<Model, Message> => ({
  model: Model.make({
    name,
    type: TypeState.Loading(),
    indexes: Indexes.Loading(),
    nameText: "",
    version: Option.none(),
    keyText: "",
    isUnique: false,
    creation: Creation.Idle(),
    action: Action.Idle(),
  }),
  commands: [FetchType({ name }), FetchIndexes({ name })],
});

// UPDATE

type UpdateReturn = Update.Return<Model, Message>;

const byName = Order.mapInput(Order.String, (index: IndexInfo) => index.name);

/** Insert or replace an index in the loaded list, keeping it sorted by name. */
const withIndex = (indexes: Indexes, index: IndexInfo): Indexes =>
  Indexes.match(indexes, {
    Loading: () => indexes,
    Failed: () => indexes,
    Loaded: ({ items }) =>
      Indexes.Loaded({
        items: Array.sort(
          Array.append(
            Array.filter(items, (item) => item.name !== index.name),
            index,
          ),
          byName,
        ),
      }),
  });

const withoutIndex = (indexes: Indexes, name: string): Indexes =>
  Indexes.match(indexes, {
    Loading: () => indexes,
    Failed: () => indexes,
    Loaded: ({ items }) => Indexes.Loaded({ items: Array.filter(items, (i) => i.name !== name) }),
  });

const isBusy = (action: Action) => action._tag === "Dropping" || action._tag === "Building";

const formProblem = (model: Model): Option.Option<string> => {
  if (String.isEmpty(model.nameText.trim())) {
    return Option.some("Give the index a name.");
  }
  if (String.isEmpty(model.keyText.trim())) {
    return Option.some("Write a key expression, such as lower(email).");
  }
  return Option.none();
};

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    SucceededFetchType: ({ info }) => ({
      model: modifyFields(model, {
        type: () => TypeState.Loaded({ info }),
        version: (version) => Option.orElse(version, () => Option.some(info.latestVersion)),
      }),
    }),
    FailedFetchType: ({ failure }) => ({
      model: modifyFields(model, { type: () => TypeState.Failed({ failure }) }),
    }),
    SucceededFetchIndexes: ({ items }) => ({
      model: modifyFields(model, { indexes: () => Indexes.Loaded({ items }) }),
    }),
    FailedFetchIndexes: ({ failure }) => ({
      model: modifyFields(model, { indexes: () => Indexes.Failed({ failure }) }),
    }),
    ClickedRefresh: () => ({
      model: modifyFields(model, { indexes: () => Indexes.Loading() }),
      commands: [FetchIndexes({ name: model.name })],
    }),
    UpdatedIndexName: ({ value }) => ({ model: modifyFields(model, { nameText: () => value }) }),
    SelectedIndexVersion: ({ version }) => ({
      model: modifyFields(model, { version: () => Option.some(version) }),
    }),
    UpdatedIndexKey: ({ value }) => ({ model: modifyFields(model, { keyText: () => value }) }),
    ClickedUseField: ({ field }) => ({
      model: modifyFields(model, {
        keyText: () => field,
        nameText: (current) => (String.isEmpty(current.trim()) ? field : current),
      }),
    }),
    ToggledUnique: () => ({ model: modifyFields(model, { isUnique: (isUnique) => !isUnique }) }),
    SubmittedNewIndex: () =>
      Option.match(model.version, {
        onNone: () => ({ model }),
        onSome: (version) => {
          if (model.creation._tag === "Submitting") {
            return { model };
          }
          return Option.match(formProblem(model), {
            onSome: (problem) => ({
              model: modifyFields(model, {
                creation: () => Creation.Invalid({ message: problem }),
              }),
            }),
            onNone: () => ({
              model: modifyFields(model, { creation: () => Creation.Submitting() }),
              commands: [
                CreateIndex({
                  type: model.name,
                  name: model.nameText.trim(),
                  version,
                  key: model.keyText.trim(),
                  unique: model.isUnique,
                }),
              ],
            }),
          });
        },
      }),
    SucceededCreateIndex: ({ index }) => ({
      model: modifyFields(model, {
        creation: () => Creation.Created({ index }),
        indexes: (indexes) => withIndex(indexes, index),
        nameText: () => "",
        keyText: () => "",
        isUnique: () => false,
      }),
    }),
    FailedCreateIndex: ({ failure }) => ({
      model: modifyFields(model, { creation: () => Creation.Failed({ failure }) }),
    }),
    ClickedDropIndex: ({ name }) =>
      isBusy(model.action)
        ? { model }
        : { model: modifyFields(model, { action: () => Action.ConfirmingDrop({ name }) }) },
    ClickedCancelDrop: () => ({ model: modifyFields(model, { action: () => Action.Idle() }) }),
    ClickedConfirmDrop: ({ name }) => ({
      model: modifyFields(model, { action: () => Action.Dropping({ name }) }),
      commands: [DropIndex({ type: model.name, name })],
    }),
    SucceededDropIndex: ({ name }) => ({
      model: modifyFields(model, {
        action: () => Action.Idle(),
        indexes: (indexes) => withoutIndex(indexes, name),
      }),
    }),
    FailedDropIndex: ({ name, failure }) => ({
      model: modifyFields(model, { action: () => Action.Failed({ name, failure }) }),
    }),
    ClickedBuildIndex: ({ name }) =>
      isBusy(model.action)
        ? { model }
        : {
            model: modifyFields(model, { action: () => Action.Building({ name }) }),
            commands: [BuildIndex({ type: model.name, name })],
          },
    SucceededBuildIndex: ({ index }) => ({
      model: modifyFields(model, {
        action: () => Action.Idle(),
        indexes: (indexes) => withIndex(indexes, index),
      }),
    }),
    FailedBuildIndex: ({ name, failure }) => ({
      model: modifyFields(model, { action: () => Action.Failed({ name, failure }) }),
    }),
  });

// VIEW

const stateVariant: Record<IndexState, BadgeVariant> = {
  ready: "secondary",
  building: "outline",
  failed: "destructive",
};

const stateBadge = (state: IndexState, h: HtmlBuilder<Message>): Html =>
  badge({ variant: stateVariant[state] }, [state], h);

const indexActions = (index: IndexInfo, action: Action, h: HtmlBuilder<Message>): Html => {
  const isThis = (name: string) => name === index.name;
  return Action.match(action, {
    ConfirmingDrop: ({ name }) =>
      isThis(name)
        ? h.div(
            [h.Class("flex items-center gap-2")],
            [
              h.span([h.Class("text-xs text-muted-foreground")], ["Drop this index?"]),
              button(
                {
                  type: "button",
                  variant: "destructive",
                  size: "sm",
                  onClick: Message.ClickedConfirmDrop({ name }),
                },
                "Drop",
                h,
              ),
              button(
                {
                  type: "button",
                  variant: "ghost",
                  size: "sm",
                  onClick: Message.ClickedCancelDrop(),
                },
                "Cancel",
                h,
              ),
            ],
          )
        : idleActions(index, false, h),
    Dropping: ({ name }) =>
      isThis(name) ? statusText("Dropping…", h) : idleActions(index, true, h),
    Building: ({ name }) =>
      isThis(name) ? statusText("Building…", h) : idleActions(index, true, h),
    Idle: () => idleActions(index, false, h),
    Failed: () => idleActions(index, false, h),
  });
};

const idleActions = (index: IndexInfo, isDisabled: boolean, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("flex items-center gap-2")],
    [
      index.state === "building"
        ? button(
            {
              type: "button",
              variant: "outline",
              size: "sm",
              isDisabled,
              onClick: Message.ClickedBuildIndex({ name: index.name }),
            },
            "Build now",
            h,
          )
        : h.empty,
      button(
        {
          type: "button",
          variant: "ghost",
          size: "sm",
          isDisabled,
          onClick: Message.ClickedDropIndex({ name: index.name }),
          attributes: [h.AriaLabel(`Drop ${index.name}`)],
        },
        "Drop",
        h,
      ),
    ],
  );

const indexItem = (index: IndexInfo, action: Action, h: HtmlBuilder<Message>): Html =>
  h.keyed("li")(
    index.name,
    [h.Class("space-y-2 rounded-lg border border-border px-3 py-2")],
    [
      h.div(
        [h.Class("flex flex-wrap items-center gap-x-3 gap-y-1")],
        [
          h.span([h.Class("font-mono text-sm font-semibold")], [index.name]),
          stateBadge(index.state, h),
          index.unique ? badge({ variant: "outline" }, ["unique"], h) : h.empty,
          badge({ variant: "outline" }, [`at v${index.version}`], h),
          h.code(
            [h.Class("min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground")],
            [index.key],
          ),
          h.span(
            [h.Class("hidden font-mono text-xs text-muted-foreground md:inline")],
            [formatTime(index.updatedAt)],
          ),
          indexActions(index, action, h),
        ],
      ),
      Option.match(index.error, {
        onNone: () => h.empty,
        onSome: (error) =>
          errorAlert(`Backfill failed: ${error}. Fix the data, then drop and recreate it.`, h),
      }),
      index.state === "building"
        ? h.p(
            [h.Class("text-xs text-muted-foreground")],
            [
              "Indexing existing entities in the background. Lookups work once it's ready; refresh to check.",
            ],
          )
        : h.empty,
      action._tag === "Failed" && action.name === index.name
        ? failureAlert(action.failure, h)
        : h.empty,
    ],
  );

const indexesView = (model: Model, h: HtmlBuilder<Message>): Html =>
  section(
    {
      title: "Indexes",
      actions: [
        button(
          {
            type: "button",
            variant: "outline",
            size: "sm",
            onClick: Message.ClickedRefresh(),
            isDisabled: model.indexes._tag === "Loading",
          },
          "Refresh",
          h,
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
              Empty(
                { className: "border border-border" },
                [
                  Empty.header(
                    {},
                    [
                      Empty.title({}, ["No indexes"], h),
                      Empty.description(
                        {},
                        ["Add one below to look entities up by a field, like email."],
                        h,
                      ),
                    ],
                    h,
                  ),
                ],
                h,
              ),
            onNonEmpty: (indexes) =>
              h.ul(
                [h.Class("space-y-2"), h.AriaLabel("Indexes")],
                Array.map(indexes, (index) => indexItem(index, model.action, h)),
              ),
          }),
      }),
    ],
    h,
  );

const creationView = (creation: Creation, h: HtmlBuilder<Message>): Html =>
  Creation.match(creation, {
    Idle: () => h.empty,
    Invalid: ({ message }) => errorAlert(message, h),
    Submitting: () => statusText("Creating index and indexing existing entities…", h),
    Failed: ({ failure }) => failureAlert(failure, h),
    Created: ({ index }) =>
      index.state === "failed"
        ? errorAlert(
            `Created ${index.name}, but its backfill failed: ${Option.getOrElse(index.error, () => "unknown error")}`,
            h,
          )
        : successAlert(
            [
              `Created ${index.name}. `,
              index.state === "ready"
                ? "It's ready for lookups on the type page."
                : "Existing entities are still being indexed in the background.",
            ],
            h,
          ),
  });

const fieldHints = (info: TypeInfo, model: Model, h: HtmlBuilder<Message>): Html => {
  const version = Option.getOrElse(model.version, () => info.latestVersion);
  const fields = Option.match(
    Array.findFirst(info.versions, (v) => v.version === version),
    { onNone: () => [], onSome: (v) => schemaFields(v.schema) },
  );
  return Array.match(fields, {
    onEmpty: () => h.empty,
    onNonEmpty: (names) =>
      h.div(
        [h.Class("flex flex-wrap items-center gap-1.5")],
        [
          h.span([h.Class(inputDescriptionClass)], [`Fields at v${version}:`]),
          ...Array.map(names, (field) =>
            button(
              {
                type: "button",
                variant: "outline",
                size: "xs",
                className: "font-mono",
                onClick: Message.ClickedUseField({ field }),
                attributes: [h.Title(`Use ${field} as the key`)],
              },
              field,
              h,
            ),
          ),
        ],
      ),
  });
};

const newIndexView = (model: Model, info: TypeInfo, h: HtmlBuilder<Message>): Html =>
  section(
    { title: "New index" },
    [
      h.form(
        [h.OnSubmit(Message.SubmittedNewIndex()), h.Class("space-y-4"), h.AriaLabel("New index")],
        [
          h.p(
            [h.Class("text-sm text-muted-foreground")],
            [
              "An index is pinned to one schema version: keys are computed from each entity's data at that version, so new versions never invalidate it. Lookups match keys exactly.",
            ],
          ),
          h.div(
            [h.Class("flex flex-wrap items-end gap-4")],
            [
              input(
                {
                  id: "index-name",
                  label: "Name",
                  value: model.nameText,
                  placeholder: "email",
                  onInput: (value) => Message.UpdatedIndexName({ value }),
                  className: "font-mono",
                  wrapperClass: "max-w-xs",
                },
                h,
              ),
              selectField(
                {
                  id: "index-version",
                  label: "Pinned to",
                  value: `${Option.getOrElse(model.version, () => info.latestVersion)}`,
                  options: versionOptions(info.latestVersion),
                  onChange: (value) => Message.SelectedIndexVersion({ version: Number(value) }),
                },
                h,
              ),
            ],
          ),
          input(
            {
              id: "index-key",
              label: "Key expression",
              value: model.keyText,
              placeholder: "lower(trim(email))",
              description:
                "Must give a string, an array of strings, or null (not indexed). Use string(…) for numbers.",
              onInput: (value) => Message.UpdatedIndexKey({ value }),
              className: "font-mono",
            },
            h,
          ),
          fieldHints(info, model, h),
          h.label(
            [h.For("index-unique"), h.Class("flex items-center gap-2 text-sm")],
            [
              h.input([
                h.Id("index-unique"),
                h.Type("checkbox"),
                h.Checked(model.isUnique),
                h.OnClick(Message.ToggledUnique()),
                h.Class("size-4 accent-primary"),
              ]),
              "Unique: no two entities may share a key",
            ],
          ),
          creationView(model.creation, h),
          button(
            { type: "submit", isDisabled: model.creation._tag === "Submitting" },
            model.creation._tag === "Submitting" ? "Creating…" : "Create index",
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
            h.a(
              [
                h.Href(href(AppRoute.TypeDetail({ name: info.name }))),
                h.Class("underline-offset-4 hover:underline"),
              ],
              [info.name],
            ),
            " / ",
          ],
          title: "Indexes",
          description: `Look up ${info.name} entities by a key computed from their data.`,
        },
        h,
      ),
      indexesView(model, h),
      newIndexView(model, info, h),
    ],
  );

export const view = Submodel.defineView<Model, Message>((model, h): Html =>
  TypeState.match(model.type, {
    Loading: () => statusText(`Loading ${model.name}…`, h),
    Failed: ({ failure }) =>
      h.div(
        [h.Class("space-y-4")],
        [
          pageHeader({ title: `${model.name} indexes` }, h),
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
