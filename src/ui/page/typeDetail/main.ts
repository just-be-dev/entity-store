import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as String from "effect/String";
import { Command, Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { pushUrl } from "foldkit/navigation";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";
import { apiUrl, deleteJson, getJson, postJson, putJson, segment } from "@/api";
import { Proposal, Submission, Usage, initDialog } from "@/components/confirm";
import * as EntityForm from "@/components/entityForm/main";
import {
  backlinkRefusals,
  entityDeleteProposal,
  entityWriteProposal,
  typeDeleteProposal,
  versionProposal,
} from "@/components/proposals";
import { Detail } from "@/components/confirm";
import * as TypeForm from "@/components/typeForm/main";
import * as Dialog from "@/components/ui/dialog";
import {
  AddedVersion,
  ApiFailure,
  BacklinkPage,
  Deleted,
  DeleteCheck,
  DeletedType,
  Entity,
  EntityPage,
  Included,
  IndexInfo,
  IndexList,
  ProjectionFailure,
  TypeConsumers,
  TypeInfo,
  TypeList,
  Upserted,
  VersionCheck,
  type VersionInfo,
} from "@/domain/entityStore";
import { readyIndexes } from "@/domain/indexes";
import { decodeSchema } from "@/domain/typeDraft";
import { entityTitle } from "@/domain/title";
import { AppRoute, href } from "@/route";
import { Lens } from "../../../lens/model.ts";
import { EntitySchema } from "../../../schema/model.ts";

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

/** A check that runs before a type write's confirmation opens. */
export const Precheck = defineTaggedUnion({
  Idle: {},
  CheckingVersion: {
    schema: EntitySchema,
    lens: Lens,
    details: Schema.Array(Detail),
    renamed: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String })),
    removed: Schema.Array(Schema.String),
  },
  CheckingDelete: {},
  Failed: { failure: ApiFailure },
});
export type Precheck = typeof Precheck.Type;

export const Links = defineTaggedUnion({
  Checking: {},
  Checked: {},
  Failed: { failure: ApiFailure },
});
export type Links = typeof Links.Type;

/** Where a prepared entity write came from, so success can reset that form. */
export const WriteSource = Schema.Literals(["new", "row"]);
export type WriteSource = typeof WriteSource.Type;

/** The write the confirmation dialog is asking about. */
export const Pending = defineTaggedUnion({
  EntityWrite: { write: EntityForm.PreparedWrite, source: WriteSource, proposal: Proposal },
  DeleteEntity: { entity: Entity, links: Links, proposal: Proposal },
  SaveVersion: {
    schema: EntitySchema,
    lens: Lens,
    expectedVersion: Schema.Int,
    proposal: Proposal,
  },
  DeleteType: { expectedVersion: Schema.Int, proposal: Proposal },
});
export type Pending = typeof Pending.Type;

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
  maybeNewEntity: Schema.Option(EntityForm.Model),
  maybeRowEditor: Schema.Option(EntityForm.Model),
  maybeTypeEditor: Schema.Option(TypeForm.Model),
  precheck: Precheck,
  dialog: Dialog.Model,
  maybePending: Schema.Option(Pending),
  submission: Submission,
  usage: Usage,
  maybeNotice: Schema.Option(Schema.String),
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
  GotNewEntityMessage: { message: EntityForm.Message },
  GotRowEditorMessage: { message: EntityForm.Message },
  GotTypeEditorMessage: { message: TypeForm.Message },
  GotDialogMessage: { message: Dialog.Message },
  ClickedEditRow: { id: Schema.String },
  ClickedDeleteRow: { id: Schema.String },
  ClickedEditFields: {},
  ClickedDeleteType: {},
  SucceededFetchTypeNames: { names: Schema.Array(Schema.String) },
  FailedFetchTypeNames: { failure: ApiFailure },
  SucceededFetchUsage: { consumers: TypeConsumers },
  FailedFetchUsage: { failure: ApiFailure },
  SucceededFetchBacklinks: { id: Schema.String, page: BacklinkPage },
  FailedFetchBacklinks: { id: Schema.String, failure: ApiFailure },
  SucceededCheckVersion: { check: VersionCheck },
  FailedCheckVersion: { failure: ApiFailure },
  SucceededCheckDelete: { check: DeleteCheck },
  FailedCheckDelete: { failure: ApiFailure },
  ClickedConfirm: {},
  SucceededSaveEntity: { entity: Entity },
  SucceededDeleteEntity: { id: Schema.String, rev: Schema.Int },
  SucceededAddVersion: { version: Schema.Int },
  SucceededDeleteType: { name: Schema.String },
  FailedWrite: { failure: ApiFailure },
  CompletedNavigateToTypes: {},
  ClickedDismissNotice: {},
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

// OUT MESSAGE

export const OutMessage = defineMessageUnion({
  ChangedTypes: {},
});
export type OutMessage = typeof OutMessage.Type;

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

export const FetchTypeNames = Command.define("FetchTypeNames", {
  messages: [Message.SucceededFetchTypeNames, Message.FailedFetchTypeNames],
  execute: getJson(apiUrl("types"), TypeList).pipe(
    Effect.map(({ items }) =>
      Message.SucceededFetchTypeNames({ names: Array.map(items, (type) => type.name) }),
    ),
    Effect.catch((failure) => Effect.succeed(Message.FailedFetchTypeNames({ failure }))),
  ),
});

export const FetchUsage = Command.define("FetchUsage", {
  args: { name: Schema.String },
  messages: [Message.SucceededFetchUsage, Message.FailedFetchUsage],
  execute: ({ name }) =>
    getJson(apiUrl(`types/${segment(name)}/consumers`), TypeConsumers).pipe(
      Effect.map((consumers) => Message.SucceededFetchUsage({ consumers })),
      Effect.catch((failure) => Effect.succeed(Message.FailedFetchUsage({ failure }))),
    ),
});

export const FetchBacklinks = Command.define("FetchBacklinks", {
  args: { id: Schema.String },
  messages: [Message.SucceededFetchBacklinks, Message.FailedFetchBacklinks],
  execute: ({ id }) =>
    getJson(apiUrl(`entities/${segment(id)}/backlinks`, { limit: "20" }), BacklinkPage).pipe(
      Effect.map((page) => Message.SucceededFetchBacklinks({ id, page })),
      Effect.catch((failure) => Effect.succeed(Message.FailedFetchBacklinks({ id, failure }))),
    ),
});

export const CheckVersion = Command.define("CheckVersion", {
  args: { name: Schema.String, schema: EntitySchema, lens: Lens, expectedVersion: Schema.Int },
  messages: [Message.SucceededCheckVersion, Message.FailedCheckVersion],
  execute: ({ name, schema, lens, expectedVersion }) =>
    postJson(
      apiUrl(`types/${segment(name)}/versions/check`),
      { schema, lens, expectedVersion },
      VersionCheck,
    ).pipe(
      Effect.map((check) => Message.SucceededCheckVersion({ check })),
      Effect.catch((failure) => Effect.succeed(Message.FailedCheckVersion({ failure }))),
    ),
});

export const CheckDelete = Command.define("CheckDelete", {
  args: { name: Schema.String, expectedVersion: Schema.Int },
  messages: [Message.SucceededCheckDelete, Message.FailedCheckDelete],
  execute: ({ name, expectedVersion }) =>
    postJson(apiUrl(`types/${segment(name)}/delete/check`), { expectedVersion }, DeleteCheck).pipe(
      Effect.map((check) => Message.SucceededCheckDelete({ check })),
      Effect.catch((failure) => Effect.succeed(Message.FailedCheckDelete({ failure }))),
    ),
});

const writeFailed = (failure: ApiFailure) => Effect.succeed(Message.FailedWrite({ failure }));

export const WriteEntity = Command.define("WriteEntity", {
  args: { write: EntityForm.PreparedWrite },
  messages: [Message.SucceededSaveEntity, Message.FailedWrite],
  execute: ({ write }) =>
    EntityForm.PreparedWrite.match(write, {
      Upsert: ({ type, id, version, patch, expectedRev }) =>
        putJson(
          apiUrl(`types/${segment(type)}/entities/${segment(id)}`),
          { version, patch, expectedRev },
          Upserted,
        ).pipe(Effect.map(({ entity }) => entity)),
      Create: ({ type, version, data }) =>
        postJson(apiUrl(`types/${segment(type)}/entities`), { version, data }, Entity),
      Replace: ({ id, version, data, expectedRev }) =>
        putJson(apiUrl(`entities/${segment(id)}`), { version, data, expectedRev }, Entity),
    }).pipe(
      Effect.map((entity) => Message.SucceededSaveEntity({ entity })),
      Effect.catch(writeFailed),
    ),
});

export const DeleteEntity = Command.define("DeleteEntity", {
  args: { id: Schema.String, expectedRev: Schema.Int },
  messages: [Message.SucceededDeleteEntity, Message.FailedWrite],
  execute: ({ id, expectedRev }) =>
    deleteJson(apiUrl(`entities/${segment(id)}`, { expectedRev: `${expectedRev}` }), Deleted).pipe(
      Effect.map((deleted) => Message.SucceededDeleteEntity({ id: deleted.id, rev: deleted.rev })),
      Effect.catch(writeFailed),
    ),
});

export const AddVersion = Command.define("AddVersion", {
  args: { name: Schema.String, schema: EntitySchema, lens: Lens, expectedVersion: Schema.Int },
  messages: [Message.SucceededAddVersion, Message.FailedWrite],
  execute: ({ name, schema, lens, expectedVersion }) =>
    postJson(
      apiUrl(`types/${segment(name)}/versions`),
      { schema, lens, expectedVersion, note: "Fields edited in the type form" },
      AddedVersion,
    ).pipe(
      Effect.map(({ version }) => Message.SucceededAddVersion({ version: version.version })),
      Effect.catch(writeFailed),
    ),
});

export const DeleteType = Command.define("DeleteType", {
  args: { name: Schema.String, expectedVersion: Schema.Int },
  messages: [Message.SucceededDeleteType, Message.FailedWrite],
  execute: ({ name, expectedVersion }) =>
    deleteJson(
      apiUrl(`types/${segment(name)}`, { expectedVersion: `${expectedVersion}` }),
      DeletedType,
    ).pipe(
      Effect.map((deleted) => Message.SucceededDeleteType({ name: deleted.name })),
      Effect.catch(writeFailed),
    ),
});

export const NavigateToTypes = Command.define("NavigateToTypes", {
  messages: [Message.CompletedNavigateToTypes],
  execute: pushUrl(href(AppRoute.TypeList())).pipe(Effect.as(Message.CompletedNavigateToTypes())),
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
    maybeNewEntity: Option.none(),
    maybeRowEditor: Option.none(),
    maybeTypeEditor: Option.none(),
    precheck: Precheck.Idle(),
    dialog: initDialog(),
    maybePending: Option.none(),
    submission: Submission.Idle(),
    usage: Usage.Loading(),
    maybeNotice: Option.none(),
  }),
  commands: [FetchType({ name }), FetchIndexes({ name })],
});

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>;
type StepReturn = Update.Return<Model, Message>;

export const versionInfo = (model: Model, version: number): Option.Option<VersionInfo> =>
  TypeState.match(model.type, {
    Loading: () => Option.none(),
    Failed: () => Option.none(),
    Loaded: ({ info }) => Array.findFirst(info.versions, (v) => v.version === version),
  });

/** A version's schema, decoded from the API's opaque JSON. */
export const schemaAt = (model: Model, version: number): Option.Option<EntitySchema> =>
  Option.flatMap(versionInfo(model, version), (info) => decodeSchema(info.schema));

const latestVersion = (model: Model): Option.Option<number> =>
  TypeState.match(model.type, {
    Loading: () => Option.none(),
    Failed: () => Option.none(),
    Loaded: ({ info }) => Option.some(info.latestVersion),
  });

const newEntityForm = (model: Model, version: number): Option.Option<EntityForm.Model> =>
  Option.map(schemaAt(model, version), (schema) =>
    EntityForm.initCreate(model.name, version, schema),
  );

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

/** The entities the page shows now: the lookup's matches while one is active, else the list. */
const shownEntities = (model: Model): ReadonlyArray<Entity> =>
  Lookup.match(model.lookup, {
    Off: () =>
      Entities.match(model.entities, {
        Idle: () => [],
        Loading: () => [],
        Failed: () => [],
        Loaded: ({ items }) => items,
      }),
    Loading: () => [],
    Failed: () => [],
    Loaded: ({ items }) => items,
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

/** Reload whatever list is showing, after a write. */
const reloadShown = (model: Model): UpdateReturn =>
  Option.match(model.readVersion, {
    onNone: () => ({ model }),
    onSome: (version) => {
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
  });

const isPendingLookup = (model: Model, index: string, key: string, version: number) =>
  model.lookup._tag === "Loading" &&
  model.lookup.index === index &&
  model.lookup.key === key &&
  model.lookup.version === version;

const withMore = (entities: Entities, more: More): Entities =>
  entities._tag === "Loaded" ? Entities.Loaded({ ...entities, more }) : entities;

// The confirmation dialog

const toDialogMessage = (message: Dialog.Message) => Message.GotDialogMessage({ message });

const readDialog = (model: Model) => Option.some(model.dialog);
const writeDialog = (model: Model, nextDialog: Dialog.Model) =>
  modifyFields(model, { dialog: () => nextDialog });

/** A closed dialog drops its pending write, unless the write is in flight. */
const foldDialogOutMessage = (outMessage: Dialog.OutMessage) =>
  Dialog.OutMessage.match(outMessage, {
    Opened: () => (stepModel: Model) => ({ model: stepModel }),
    Closed: () => (stepModel: Model) => ({
      model:
        stepModel.submission._tag === "Working"
          ? stepModel
          : modifyFields(stepModel, {
              maybePending: () => Option.none(),
              submission: () => Submission.Idle(),
            }),
    }),
  });

const foldDialog = Update.foldChild({
  update: Dialog.update,
  read: readDialog,
  write: writeDialog,
  toParentMessage: toDialogMessage,
  foldOutMessage: foldDialogOutMessage,
});

const openDialog = Update.foldChildStep({
  update: Dialog.open,
  read: readDialog,
  write: writeDialog,
  toParentMessage: toDialogMessage,
  foldOutMessage: foldDialogOutMessage,
});

const closeDialog = Update.foldChildStep({
  update: Dialog.close,
  read: readDialog,
  write: writeDialog,
  toParentMessage: toDialogMessage,
  foldOutMessage: foldDialogOutMessage,
});

/** Ask about `pending` in the dialog, fetching who uses the type unless `usage` is known. */
const propose = (model: Model, pending: Pending, usage: Option.Option<Usage> = Option.none()) =>
  Update.combine(model, [
    (stepModel: Model): StepReturn => ({
      model: modifyFields(stepModel, {
        maybePending: () => Option.some(pending),
        submission: () => Submission.Idle(),
        usage: () => Option.getOrElse(usage, () => Usage.Loading()),
        maybeNotice: () => Option.none(),
      }),
      commands: Option.isSome(usage) ? [] : [FetchUsage({ name: stepModel.name })],
    }),
    openDialog,
  ]);

/** After a write: close the dialog, say what happened. */
const settle = (model: Model, notice: string): UpdateReturn =>
  closeDialog(
    modifyFields(model, {
      maybePending: () => Option.none(),
      submission: () => Submission.Idle(),
      maybeNotice: () => Option.some(notice),
    }),
  );

// Child forms

const toNewEntityMessage = (message: EntityForm.Message) =>
  Message.GotNewEntityMessage({ message });
const toRowEditorMessage = (message: EntityForm.Message) =>
  Message.GotRowEditorMessage({ message });
const toTypeEditorMessage = (message: TypeForm.Message) =>
  Message.GotTypeEditorMessage({ message });

const foldNewEntity = Update.foldChild({
  update: EntityForm.update,
  read: (model: Model) => model.maybeNewEntity,
  write: (model: Model, nextForm: EntityForm.Model) =>
    modifyFields(model, { maybeNewEntity: () => Option.some(nextForm) }),
  toParentMessage: toNewEntityMessage,
  foldOutMessage: (outMessage) =>
    EntityForm.OutMessage.match(outMessage, {
      PreparedWrite:
        ({ write }) =>
        (stepModel: Model) =>
          propose(
            stepModel,
            Pending.EntityWrite({ write, source: "new", proposal: entityWriteProposal(write) }),
          ),
      Cancelled: () => (stepModel: Model) => ({
        model: modifyFields(stepModel, {
          maybeNewEntity: () =>
            Option.flatMap(stepModel.writeVersion, (version) => newEntityForm(stepModel, version)),
        }),
      }),
    }),
});

const foldRowEditor = Update.foldChild({
  update: EntityForm.update,
  read: (model: Model) => model.maybeRowEditor,
  write: (model: Model, nextForm: EntityForm.Model) =>
    modifyFields(model, { maybeRowEditor: () => Option.some(nextForm) }),
  toParentMessage: toRowEditorMessage,
  foldOutMessage: (outMessage) =>
    EntityForm.OutMessage.match(outMessage, {
      PreparedWrite:
        ({ write }) =>
        (stepModel: Model) =>
          propose(
            stepModel,
            Pending.EntityWrite({ write, source: "row", proposal: entityWriteProposal(write) }),
          ),
      Cancelled: () => (stepModel: Model) => ({
        model: modifyFields(stepModel, { maybeRowEditor: () => Option.none() }),
      }),
    }),
});

const foldTypeEditor = Update.foldChild({
  update: TypeForm.update,
  read: (model: Model) => model.maybeTypeEditor,
  write: (model: Model, nextForm: TypeForm.Model) =>
    modifyFields(model, { maybeTypeEditor: () => Option.some(nextForm) }),
  toParentMessage: toTypeEditorMessage,
  foldOutMessage: (outMessage) =>
    TypeForm.OutMessage.match(outMessage, {
      SubmittedNewType: () => (stepModel: Model) => ({ model: stepModel }),
      SubmittedVersion:
        ({ schema, lens, details, renamed, removed }) =>
        (stepModel: Model) =>
          Option.match(latestVersion(stepModel), {
            onNone: () => ({ model: stepModel }),
            onSome: (expectedVersion) => ({
              model: modifyFields(stepModel, {
                precheck: () =>
                  Precheck.CheckingVersion({ schema, lens, details, renamed, removed }),
              }),
              commands: [CheckVersion({ name: stepModel.name, schema, lens, expectedVersion })],
            }),
          }),
      Cancelled: () => (stepModel: Model) => ({
        model: modifyFields(stepModel, {
          maybeTypeEditor: () => Option.none(),
          precheck: () => Precheck.Idle(),
        }),
      }),
    }),
});

const foldTypeEditorTargets = Update.foldChild({
  update: TypeForm.withTargets,
  read: (model: Model) => model.maybeTypeEditor,
  write: (model: Model, nextForm: TypeForm.Model) =>
    modifyFields(model, { maybeTypeEditor: () => Option.some(nextForm) }),
  toParentMessage: toTypeEditorMessage,
});

const findShown = (model: Model, id: string): Option.Option<Entity> =>
  Array.findFirst(shownEntities(model), (entity) => entity.id === id);

const titleOf = (model: Model, entity: Entity): Option.Option<string> =>
  Option.flatMap(versionInfo(model, entity.version), (info) =>
    entityTitle(info.schema, entity.data),
  );

const withPending = (model: Model, change: (pending: Pending) => Pending): Model =>
  modifyFields(model, { maybePending: (pending) => Option.map(pending, change) });

const confirm = (model: Model, pending: Pending): UpdateReturn => {
  const working = modifyFields(model, { submission: () => Submission.Working() });
  return Pending.match<UpdateReturn>(pending, {
    EntityWrite: ({ write }) => ({ model: working, commands: [WriteEntity({ write })] }),
    DeleteEntity: ({ entity }) => ({
      model: working,
      commands: [DeleteEntity({ id: entity.id, expectedRev: entity.rev })],
    }),
    SaveVersion: ({ schema, lens, expectedVersion }) => ({
      model: working,
      commands: [AddVersion({ name: model.name, schema, lens, expectedVersion })],
    }),
    DeleteType: ({ expectedVersion }) => ({
      model: working,
      commands: [DeleteType({ name: model.name, expectedVersion })],
    }),
  });
};

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    SucceededFetchType: ({ info }) => {
      const loaded = modifyFields(model, {
        type: () => TypeState.Loaded({ info }),
        writeVersion: () => Option.some(info.latestVersion),
      });
      return loadEntities(
        modifyFields(loaded, {
          maybeNewEntity: () => newEntityForm(loaded, info.latestVersion),
          maybeRowEditor: () => Option.none(),
        }),
        info.latestVersion,
      );
    },
    FailedFetchType: ({ failure }) => ({
      model: modifyFields(model, { type: () => TypeState.Failed({ failure }) }),
    }),
    SelectedReadVersion: ({ version }) =>
      reloadShown(
        modifyFields(model, {
          readVersion: () => Option.some(version),
          maybeRowEditor: () => Option.none(),
        }),
      ),
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
      Entities.match<UpdateReturn>(model.entities, {
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
    SelectedWriteVersion: ({ version }) => ({
      model: modifyFields(model, {
        writeVersion: () => Option.some(version),
        maybeNewEntity: () => newEntityForm(model, version),
      }),
    }),
    GotNewEntityMessage: ({ message: formMessage }) => foldNewEntity(model, formMessage),
    GotRowEditorMessage: ({ message: formMessage }) => foldRowEditor(model, formMessage),
    GotTypeEditorMessage: ({ message: formMessage }) => foldTypeEditor(model, formMessage),
    GotDialogMessage: ({ message: dialogMessage }) => foldDialog(model, dialogMessage),
    ClickedEditRow: ({ id }) =>
      Option.match(
        Option.flatMap(findShown(model, id), (entity) =>
          Option.map(schemaAt(model, entity.version), (schema) =>
            EntityForm.initEdit(entity, schema),
          ),
        ),
        {
          onNone: () => ({ model }),
          onSome: (form) => ({
            model: modifyFields(model, {
              maybeRowEditor: () => Option.some(form),
              maybeNotice: () => Option.none(),
            }),
          }),
        },
      ),
    ClickedDeleteRow: ({ id }) =>
      Option.match(findShown(model, id), {
        onNone: () => ({ model }),
        onSome: (entity) => {
          const proposed = propose(
            model,
            Pending.DeleteEntity({
              entity,
              links: Links.Checking(),
              proposal: entityDeleteProposal(entity, titleOf(model, entity)),
            }),
          );
          return {
            ...proposed,
            commands: [...(proposed.commands ?? []), FetchBacklinks({ id })],
          };
        },
      }),
    ClickedEditFields: () =>
      Option.match(
        Option.flatMap(latestVersion(model), (version) =>
          Option.map(schemaAt(model, version), (schema) =>
            TypeForm.initEdit(model.name, version, schema, []),
          ),
        ),
        {
          onNone: () => ({ model }),
          onSome: (form) => ({
            model: modifyFields(model, {
              maybeTypeEditor: () => Option.some(form),
              precheck: () => Precheck.Idle(),
              maybeNotice: () => Option.none(),
            }),
            commands: [FetchTypeNames()],
          }),
        },
      ),
    ClickedDeleteType: () =>
      Option.match(latestVersion(model), {
        onNone: () => ({ model }),
        onSome: (expectedVersion) =>
          model.precheck._tag === "CheckingDelete"
            ? { model }
            : {
                model: modifyFields(model, {
                  precheck: () => Precheck.CheckingDelete(),
                  maybeNotice: () => Option.none(),
                }),
                commands: [CheckDelete({ name: model.name, expectedVersion })],
              },
      }),
    SucceededFetchTypeNames: ({ names }) => foldTypeEditorTargets(model, names),
    FailedFetchTypeNames: () => ({ model }),
    SucceededFetchUsage: ({ consumers }) => ({
      model: modifyFields(model, { usage: () => Usage.Loaded({ usage: consumers.automations }) }),
    }),
    FailedFetchUsage: ({ failure }) => ({
      model: modifyFields(model, { usage: () => Usage.Failed({ failure }) }),
    }),
    SucceededFetchBacklinks: ({ id, page }) => ({
      model: withPending(model, (pending) =>
        pending._tag === "DeleteEntity" && pending.entity.id === id
          ? Pending.DeleteEntity({
              ...pending,
              links: Links.Checked(),
              proposal: Proposal.make({
                ...pending.proposal,
                refusals: backlinkRefusals(page.items, Option.isSome(page.nextCursor)),
              }),
            })
          : pending,
      ),
    }),
    FailedFetchBacklinks: ({ id, failure }) => ({
      model: withPending(model, (pending) =>
        pending._tag === "DeleteEntity" && pending.entity.id === id
          ? Pending.DeleteEntity({ ...pending, links: Links.Failed({ failure }) })
          : pending,
      ),
    }),
    SucceededCheckVersion: ({ check }) =>
      Precheck.match<UpdateReturn>(model.precheck, {
        Idle: () => ({ model }),
        CheckingDelete: () => ({ model }),
        Failed: () => ({ model }),
        CheckingVersion: ({ schema, lens, details, renamed, removed }) =>
          propose(
            modifyFields(model, { precheck: () => Precheck.Idle() }),
            Pending.SaveVersion({
              schema,
              lens,
              expectedVersion: check.from,
              proposal: versionProposal({
                type: model.name,
                from: check.from,
                opCount: lens.ops.length,
                details,
                renamed,
                removed,
                report: check.report,
              }),
            }),
          ),
      }),
    FailedCheckVersion: ({ failure }) =>
      model.precheck._tag === "CheckingVersion"
        ? { model: modifyFields(model, { precheck: () => Precheck.Failed({ failure }) }) }
        : { model },
    SucceededCheckDelete: ({ check }) =>
      model.precheck._tag === "CheckingDelete"
        ? propose(
            modifyFields(model, { precheck: () => Precheck.Idle() }),
            Pending.DeleteType({
              expectedVersion: check.latestVersion,
              proposal: typeDeleteProposal({
                type: check.type,
                latestVersion: check.latestVersion,
                reasons: check.reasons,
              }),
            }),
            Option.some(Usage.Loaded({ usage: check.consumers.automations })),
          )
        : { model },
    FailedCheckDelete: ({ failure }) =>
      model.precheck._tag === "CheckingDelete"
        ? { model: modifyFields(model, { precheck: () => Precheck.Failed({ failure }) }) }
        : { model },
    ClickedConfirm: () =>
      Option.match(model.maybePending, {
        onNone: () => ({ model }),
        onSome: (pending) =>
          model.submission._tag === "Working" ||
          Array.isReadonlyArrayNonEmpty(pending.proposal.refusals) ||
          (pending._tag === "DeleteEntity" && pending.links._tag === "Checking")
            ? { model }
            : confirm(model, pending),
      }),
    SucceededSaveEntity: ({ entity }) => {
      const source = Option.match(model.maybePending, {
        onNone: () => "new",
        onSome: (pending) => (pending._tag === "EntityWrite" ? pending.source : "new"),
      });
      const reset = modifyFields(model, {
        maybeNewEntity: (form) =>
          source === "new"
            ? Option.flatMap(model.writeVersion, (version) => newEntityForm(model, version))
            : form,
        maybeRowEditor: (form) => (source === "row" ? Option.none() : form),
      });
      const settled = settle(reset, `Saved ${entity.id} at rev ${entity.rev}.`);
      const reloaded = reloadShown(settled.model);
      return {
        model: reloaded.model,
        commands: [...(settled.commands ?? []), ...(reloaded.commands ?? [])],
      };
    },
    SucceededDeleteEntity: ({ id, rev }) => {
      const settled = settle(
        modifyFields(model, {
          maybeRowEditor: (form) => Option.filter(form, (editor) => editor.idText !== id),
        }),
        `Deleted ${id} at rev ${rev}. Its history is kept.`,
      );
      const reloaded = reloadShown(settled.model);
      return {
        model: reloaded.model,
        commands: [...(settled.commands ?? []), ...(reloaded.commands ?? [])],
      };
    },
    SucceededAddVersion: ({ version }) => {
      const settled = settle(
        modifyFields(model, { maybeTypeEditor: () => Option.none() }),
        `Saved ${model.name} v${version}.`,
      );
      return {
        model: settled.model,
        commands: [...(settled.commands ?? []), FetchType({ name: model.name })],
        outMessage: OutMessage.ChangedTypes(),
      };
    },
    SucceededDeleteType: () => {
      const settled = settle(model, `Deleted ${model.name}.`);
      return {
        model: settled.model,
        commands: [...(settled.commands ?? []), NavigateToTypes()],
        outMessage: OutMessage.ChangedTypes(),
      };
    },
    FailedWrite: ({ failure }) => ({
      model: modifyFields(model, { submission: () => Submission.Failed({ failure }) }),
    }),
    CompletedNavigateToTypes: () => ({ model }),
    ClickedDismissNotice: () => ({
      model: modifyFields(model, { maybeNotice: () => Option.none() }),
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
