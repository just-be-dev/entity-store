import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Submodel, Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { pushUrl } from "foldkit/navigation";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";
import { apiUrl, deleteJson, getJson, postJson, putJson, segment } from "@/api";
import { Proposal, Submission, Usage, confirmDialog, initDialog } from "@/components/confirm";
import * as EntityForm from "@/components/entityForm/main";
import { failureAlert, successAlert } from "@/components/feedback";
import { jsonBlock } from "@/components/json";
import { facts, pageHeader, section, statusText } from "@/components/layout";
import { entityLink, preview } from "@/components/links";
import {
  backlinkRefusals,
  entityDeleteProposal,
  entityWriteProposal,
} from "@/components/proposals";
import { selectField, versionOptions } from "@/components/select";
import { badge } from "@/components/ui/badge";
import { button } from "@/components/ui/button";
import * as Dialog from "@/components/ui/dialog";
import {
  ApiFailure,
  Backlink,
  BacklinkPage,
  Deleted,
  Entity,
  EntityWithLinks,
  HistoryPage,
  Included,
  Revision,
  RevisionFailure,
  TypeConsumers,
  TypeInfo,
  Upserted,
} from "@/domain/entityStore";
import { type OutgoingLink, outgoingLinks } from "@/domain/links";
import { entityTitle } from "@/domain/title";
import { decodeSchema } from "@/domain/typeDraft";
import { formatTime } from "@/lib/format";
import { AppRoute, href } from "@/route";
import type { EntitySchema } from "../../../schema/model.ts";

// MODEL

export const EntityState = defineTaggedUnion({
  Loading: {},
  Failed: { failure: ApiFailure },
  Loaded: { entity: Entity, included: Included },
});
export type EntityState = typeof EntityState.Type;

/** The entity's type, for its schemas (to find link fields) and latest version. */
export const TypeState = defineTaggedUnion({
  Idle: {},
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

export const History = defineTaggedUnion({
  Loading: {},
  Failed: { failure: ApiFailure },
  Loaded: {
    type: Schema.String,
    items: Schema.Array(Revision),
    failures: Schema.Array(RevisionFailure),
    nextBefore: Schema.Option(Schema.Int),
    more: More,
  },
});
export type History = typeof History.Type;

export const Backlinks = defineTaggedUnion({
  Loading: {},
  Failed: { failure: ApiFailure },
  Loaded: {
    items: Schema.Array(Backlink),
    nextCursor: Schema.Option(Schema.String),
    more: More,
  },
});
export type Backlinks = typeof Backlinks.Type;

/** The entity as the editor writes it: loading at a version, or a form over it. */
export const Editor = defineTaggedUnion({
  Idle: {},
  Loading: { version: Schema.Int },
  Failed: { version: Schema.Int, failure: ApiFailure },
  /** The entity is loaded at the version, but its type (for the form) isn't yet. */
  Waiting: { entity: Entity },
  Editing: { form: EntityForm.Model },
});
export type Editor = typeof Editor.Type;

/** The write the confirmation dialog is asking about. */
export const Pending = defineTaggedUnion({
  Save: { write: EntityForm.PreparedWrite, proposal: Proposal },
  Delete: { entity: Entity, proposal: Proposal },
});
export type Pending = typeof Pending.Type;

export const Model = Schema.Struct({
  id: Schema.String,
  presentVersion: Schema.Option(Schema.Int),
  latestVersion: Schema.Option(Schema.Int),
  entity: EntityState,
  type: TypeState,
  backlinks: Backlinks,
  history: History,
  editor: Editor,
  dialog: Dialog.Model,
  maybePending: Schema.Option(Pending),
  submission: Submission,
  usage: Usage,
  maybeNotice: Schema.Option(Schema.String),
});
export type Model = typeof Model.Type;

// MESSAGE

const Requested = Schema.Option(Schema.Int);

export const Message = defineMessageUnion({
  SucceededFetchEntity: { requested: Requested, entity: Entity, included: Included },
  FailedFetchEntity: { requested: Requested, failure: ApiFailure },
  SelectedPresentVersion: { version: Schema.Int },
  SucceededFetchType: { info: TypeInfo },
  FailedFetchType: { failure: ApiFailure },
  SucceededFetchBacklinks: { page: BacklinkPage },
  FailedFetchBacklinks: { failure: ApiFailure },
  ClickedLoadMoreBacklinks: {},
  SucceededFetchMoreBacklinks: { page: BacklinkPage },
  FailedFetchMoreBacklinks: { failure: ApiFailure },
  SucceededFetchHistory: { requested: Requested, page: HistoryPage },
  FailedFetchHistory: { requested: Requested, failure: ApiFailure },
  ClickedLoadMoreHistory: {},
  SucceededFetchMoreHistory: { requested: Requested, page: HistoryPage },
  FailedFetchMoreHistory: { requested: Requested, failure: ApiFailure },
  SelectedWriteVersion: { version: Schema.Int },
  SucceededFetchEditBase: { entity: Entity },
  FailedFetchEditBase: { version: Schema.Int, failure: ApiFailure },
  GotEditorMessage: { message: EntityForm.Message },
  GotDialogMessage: { message: Dialog.Message },
  SucceededFetchUsage: { consumers: TypeConsumers },
  FailedFetchUsage: { failure: ApiFailure },
  ClickedConfirm: {},
  SucceededSaveEntity: { entity: Entity },
  ClickedReload: {},
  ClickedDelete: {},
  SucceededDeleteEntity: { type: Schema.String },
  FailedWrite: { failure: ApiFailure },
  ClickedDismissNotice: {},
  CompletedNavigateToType: {},
});
export type Message = typeof Message.Type;

// COMMAND

const versionQuery = (version: Option.Option<number>): Readonly<Record<string, string>> =>
  Option.match(version, { onNone: () => ({}), onSome: (v) => ({ version: `${v}` }) });

export const FetchEntity = Command.define("FetchEntity", {
  args: { id: Schema.String, version: Requested },
  messages: [Message.SucceededFetchEntity, Message.FailedFetchEntity],
  execute: ({ id, version }) =>
    getJson(
      apiUrl(`entities/${segment(id)}`, { ...versionQuery(version), include: "links" }),
      EntityWithLinks,
    ).pipe(
      Effect.map(({ included, ...entity }) =>
        Message.SucceededFetchEntity({ requested: version, entity, included: included ?? {} }),
      ),
      Effect.catch((failure) =>
        Effect.succeed(Message.FailedFetchEntity({ requested: version, failure })),
      ),
    ),
});

export const FetchType = Command.define("FetchType", {
  args: { name: Schema.String },
  messages: [Message.SucceededFetchType, Message.FailedFetchType],
  execute: ({ name }) =>
    getJson(apiUrl(`types/${segment(name)}`), TypeInfo).pipe(
      Effect.map((info) => Message.SucceededFetchType({ info })),
      Effect.catch((failure) => Effect.succeed(Message.FailedFetchType({ failure }))),
    ),
});

const backlinksUrl = (id: string, cursor: Option.Option<string>) =>
  apiUrl(`entities/${segment(id)}/backlinks`, {
    limit: "20",
    ...Option.match(cursor, { onNone: () => ({}), onSome: (value) => ({ cursor: value }) }),
  });

export const FetchBacklinks = Command.define("FetchBacklinks", {
  args: { id: Schema.String },
  messages: [Message.SucceededFetchBacklinks, Message.FailedFetchBacklinks],
  execute: ({ id }) =>
    getJson(backlinksUrl(id, Option.none()), BacklinkPage).pipe(
      Effect.map((page) => Message.SucceededFetchBacklinks({ page })),
      Effect.catch((failure) => Effect.succeed(Message.FailedFetchBacklinks({ failure }))),
    ),
});

export const FetchMoreBacklinks = Command.define("FetchMoreBacklinks", {
  args: { id: Schema.String, cursor: Schema.String },
  messages: [Message.SucceededFetchMoreBacklinks, Message.FailedFetchMoreBacklinks],
  execute: ({ id, cursor }) =>
    getJson(backlinksUrl(id, Option.some(cursor)), BacklinkPage).pipe(
      Effect.map((page) => Message.SucceededFetchMoreBacklinks({ page })),
      Effect.catch((failure) => Effect.succeed(Message.FailedFetchMoreBacklinks({ failure }))),
    ),
});

const historyUrl = (id: string, version: Option.Option<number>, before: Option.Option<number>) =>
  apiUrl(`entities/${segment(id)}/history`, {
    ...versionQuery(version),
    limit: "20",
    ...Option.match(before, { onNone: () => ({}), onSome: (b) => ({ before: `${b}` }) }),
  });

export const FetchHistory = Command.define("FetchHistory", {
  args: { id: Schema.String, version: Requested },
  messages: [Message.SucceededFetchHistory, Message.FailedFetchHistory],
  execute: ({ id, version }) =>
    getJson(historyUrl(id, version, Option.none()), HistoryPage).pipe(
      Effect.map((page) => Message.SucceededFetchHistory({ requested: version, page })),
      Effect.catch((failure) =>
        Effect.succeed(Message.FailedFetchHistory({ requested: version, failure })),
      ),
    ),
});

export const FetchMoreHistory = Command.define("FetchMoreHistory", {
  args: { id: Schema.String, version: Requested, before: Schema.Int },
  messages: [Message.SucceededFetchMoreHistory, Message.FailedFetchMoreHistory],
  execute: ({ id, version, before }) =>
    getJson(historyUrl(id, version, Option.some(before)), HistoryPage).pipe(
      Effect.map((page) => Message.SucceededFetchMoreHistory({ requested: version, page })),
      Effect.catch((failure) =>
        Effect.succeed(Message.FailedFetchMoreHistory({ requested: version, failure })),
      ),
    ),
});

export const FetchEditBase = Command.define("FetchEditBase", {
  args: { id: Schema.String, version: Schema.Int },
  messages: [Message.SucceededFetchEditBase, Message.FailedFetchEditBase],
  execute: ({ id, version }) =>
    getJson(apiUrl(`entities/${segment(id)}`, versionQuery(Option.some(version))), Entity).pipe(
      Effect.map((entity) => Message.SucceededFetchEditBase({ entity })),
      Effect.catch((failure) => Effect.succeed(Message.FailedFetchEditBase({ version, failure }))),
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
      Effect.catch((failure) => Effect.succeed(Message.FailedWrite({ failure }))),
    ),
});

export const DeleteEntity = Command.define("DeleteEntity", {
  args: { id: Schema.String, type: Schema.String, expectedRev: Schema.Int },
  messages: [Message.SucceededDeleteEntity, Message.FailedWrite],
  execute: ({ id, type, expectedRev }) =>
    deleteJson(apiUrl(`entities/${segment(id)}`, { expectedRev: `${expectedRev}` }), Deleted).pipe(
      Effect.as(Message.SucceededDeleteEntity({ type })),
      Effect.catch((failure) => Effect.succeed(Message.FailedWrite({ failure }))),
    ),
});

export const NavigateToType = Command.define("NavigateToType", {
  args: { name: Schema.String },
  messages: [Message.CompletedNavigateToType],
  execute: ({ name }) =>
    pushUrl(href(AppRoute.TypeDetail({ name }))).pipe(Effect.as(Message.CompletedNavigateToType())),
});

// INIT

export const init = (id: string): Update.Return<Model, Message> => ({
  model: Model.make({
    id,
    presentVersion: Option.none(),
    latestVersion: Option.none(),
    entity: EntityState.Loading(),
    type: TypeState.Idle(),
    backlinks: Backlinks.Loading(),
    history: History.Loading(),
    editor: Editor.Idle(),
    dialog: initDialog(),
    maybePending: Option.none(),
    submission: Submission.Idle(),
    usage: Usage.Loading(),
    maybeNotice: Option.none(),
  }),
  commands: [
    FetchEntity({ id, version: Option.none() }),
    FetchHistory({ id, version: Option.none() }),
    FetchBacklinks({ id }),
  ],
});

// UPDATE

type UpdateReturn = Update.Return<Model, Message>;

const sameRequest = (a: Option.Option<number>, b: Option.Option<number>) =>
  Option.getOrElse(a, () => 0) === Option.getOrElse(b, () => 0);

/** Reload what's shown at the presented version. */
const reloadShown = (model: Model): UpdateReturn => ({
  model: modifyFields(model, {
    entity: () => EntityState.Loading(),
    history: () => History.Loading(),
  }),
  commands: [
    FetchEntity({ id: model.id, version: model.presentVersion }),
    FetchHistory({ id: model.id, version: model.presentVersion }),
  ],
});

/** A version's schema, from the type once it has loaded. */
const schemaAt = (type: TypeState, version: number): Option.Option<EntitySchema> =>
  TypeState.match(type, {
    Idle: () => Option.none(),
    Loading: () => Option.none(),
    Failed: () => Option.none(),
    Loaded: ({ info }) =>
      Option.flatMap(
        Array.findFirst(info.versions, (candidate) => candidate.version === version),
        (found) => decodeSchema(found.schema),
      ),
  });

/** A form over `entity` once its type's schema for that version is known. */
const editing = (entity: Entity, type: TypeState): Editor =>
  Option.match(schemaAt(type, entity.version), {
    onNone: () => Editor.Waiting({ entity }),
    onSome: (schema) => Editor.Editing({ form: EntityForm.initEdit(entity, schema) }),
  });

/** Fetch the type once its name is known. */
const loadType = (result: UpdateReturn, name: string): UpdateReturn =>
  result.model.type._tag === "Idle"
    ? {
        model: modifyFields(result.model, { type: () => TypeState.Loading() }),
        commands: [...(result.commands ?? []), FetchType({ name })],
      }
    : result;

const reloadBacklinks = (result: UpdateReturn): UpdateReturn => ({
  model: modifyFields(result.model, { backlinks: () => Backlinks.Loading() }),
  commands: [...(result.commands ?? []), FetchBacklinks({ id: result.model.id })],
});

const withBacklinksMore = (backlinks: Backlinks, more: More): Backlinks =>
  backlinks._tag === "Loaded" ? Backlinks.Loaded({ ...backlinks, more }) : backlinks;

const withHistoryMore = (history: History, more: More): History =>
  history._tag === "Loaded" ? History.Loaded({ ...history, more }) : history;

type LoadedHistory = Extract<History, { readonly _tag: "Loaded" }>;

const loadedHistory = (model: Model): Option.Option<LoadedHistory> =>
  History.match<Option.Option<LoadedHistory>>(model.history, {
    Loading: () => Option.none(),
    Failed: () => Option.none(),
    Loaded: (loaded) => Option.some(loaded),
  });

/** The entity's type, from whichever of the entity or its history has loaded. */
export const typeName = (model: Model): Option.Option<string> =>
  EntityState.match<Option.Option<string>>(model.entity, {
    Loaded: ({ entity }) => Option.some(entity.type),
    Loading: () => Option.map(loadedHistory(model), (history) => history.type),
    Failed: () => Option.map(loadedHistory(model), (history) => history.type),
  });

const editorVersion = (editor: Editor): Option.Option<number> =>
  Editor.match<Option.Option<number>>(editor, {
    Idle: () => Option.none(),
    Loading: ({ version }) => Option.some(version),
    Failed: ({ version }) => Option.some(version),
    Waiting: ({ entity }) => Option.some(entity.version),
    Editing: ({ form }) => Option.some(form.version),
  });

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

const propose = (model: Model, pending: Pending, type: string): UpdateReturn =>
  Update.combine(model, [
    (stepModel: Model): UpdateReturn => ({
      model: modifyFields(stepModel, {
        maybePending: () => Option.some(pending),
        submission: () => Submission.Idle(),
        usage: () => Usage.Loading(),
        maybeNotice: () => Option.none(),
      }),
      commands: [FetchUsage({ name: type })],
    }),
    openDialog,
  ]);

const foldEditor = Update.foldChild({
  update: EntityForm.update,
  read: (model: Model) =>
    model.editor._tag === "Editing" ? Option.some(model.editor.form) : Option.none(),
  write: (model: Model, nextForm: EntityForm.Model): Model =>
    modifyFields(model, { editor: (): Editor => Editor.Editing({ form: nextForm }) }),
  toParentMessage: (message: EntityForm.Message) => Message.GotEditorMessage({ message }),
  foldOutMessage: (outMessage) =>
    EntityForm.OutMessage.match(outMessage, {
      PreparedWrite:
        ({ write }) =>
        (stepModel: Model): UpdateReturn =>
          propose(
            stepModel,
            Pending.Save({ write, proposal: entityWriteProposal(write) }),
            write.type,
          ),
      Cancelled:
        () =>
        (stepModel: Model): UpdateReturn =>
          EntityState.match<UpdateReturn>(stepModel.entity, {
            Loading: () => ({ model: stepModel }),
            Failed: () => ({ model: stepModel }),
            Loaded: () =>
              Option.match(editorVersion(stepModel.editor), {
                onNone: () => ({ model: stepModel }),
                onSome: (version) => ({
                  model: modifyFields(stepModel, { editor: () => Editor.Loading({ version }) }),
                  commands: [FetchEditBase({ id: stepModel.id, version })],
                }),
              }),
          }),
    }),
});

/** The pending write's confirmation, with a delete refused while anything links to the entity. */
const proposalOf = (model: Model, pending: Pending): Proposal =>
  Pending.match(pending, {
    Save: ({ proposal }) => proposal,
    Delete: ({ proposal }) =>
      Backlinks.match(model.backlinks, {
        Loading: () => proposal,
        Failed: () => proposal,
        Loaded: ({ items, nextCursor }) =>
          Proposal.make({
            ...proposal,
            refusals: backlinkRefusals(items, Option.isSome(nextCursor)),
          }),
      }),
  });

const isRefused = (model: Model, pending: Pending): boolean =>
  Array.isReadonlyArrayNonEmpty(proposalOf(model, pending).refusals) ||
  (pending._tag === "Delete" && model.backlinks._tag === "Loading");

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    SucceededFetchEntity: ({ requested, entity, included }) =>
      sameRequest(requested, model.presentVersion)
        ? loadType(
            {
              model: modifyFields(model, {
                entity: () => EntityState.Loaded({ entity, included }),
                latestVersion: (latest) =>
                  Option.isNone(requested) ? Option.some(entity.version) : latest,
                editor: (editor) => (editor._tag === "Idle" ? editing(entity, model.type) : editor),
              }),
            },
            entity.type,
          )
        : { model },
    FailedFetchEntity: ({ requested, failure }) =>
      sameRequest(requested, model.presentVersion)
        ? { model: modifyFields(model, { entity: () => EntityState.Failed({ failure }) }) }
        : { model },
    SelectedPresentVersion: ({ version }) =>
      reloadShown(modifyFields(model, { presentVersion: () => Option.some(version) })),
    SucceededFetchType: ({ info }) => {
      const type = TypeState.Loaded({ info });
      return {
        model: modifyFields(model, {
          type: () => type,
          latestVersion: () => Option.some(info.latestVersion),
          editor: (editor) => (editor._tag === "Waiting" ? editing(editor.entity, type) : editor),
        }),
      };
    },
    FailedFetchType: ({ failure }) => ({
      model: modifyFields(model, { type: () => TypeState.Failed({ failure }) }),
    }),
    SucceededFetchBacklinks: ({ page }) => ({
      model: modifyFields(model, {
        backlinks: () =>
          Backlinks.Loaded({ items: page.items, nextCursor: page.nextCursor, more: More.Idle() }),
      }),
    }),
    FailedFetchBacklinks: ({ failure }) => ({
      model: modifyFields(model, { backlinks: () => Backlinks.Failed({ failure }) }),
    }),
    ClickedLoadMoreBacklinks: () =>
      Backlinks.match<UpdateReturn>(model.backlinks, {
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
                      backlinks: (backlinks) => withBacklinksMore(backlinks, More.Loading()),
                    }),
                    commands: [FetchMoreBacklinks({ id: model.id, cursor })],
                  },
          }),
      }),
    SucceededFetchMoreBacklinks: ({ page }) =>
      Backlinks.match<UpdateReturn>(model.backlinks, {
        Loading: () => ({ model }),
        Failed: () => ({ model }),
        Loaded: (loaded) => ({
          model: modifyFields(model, {
            backlinks: () =>
              Backlinks.Loaded({
                items: Array.appendAll(loaded.items, page.items),
                nextCursor: page.nextCursor,
                more: More.Idle(),
              }),
          }),
        }),
      }),
    FailedFetchMoreBacklinks: ({ failure }) => ({
      model: modifyFields(model, {
        backlinks: (backlinks) => withBacklinksMore(backlinks, More.Failed({ failure })),
      }),
    }),
    SucceededFetchHistory: ({ requested, page }) =>
      sameRequest(requested, model.presentVersion)
        ? loadType(
            {
              model: modifyFields(model, {
                history: () =>
                  History.Loaded({
                    type: page.type,
                    items: page.items,
                    failures: page.failures,
                    nextBefore: page.nextBefore,
                    more: More.Idle(),
                  }),
                latestVersion: (latest) =>
                  Option.isNone(requested) && Option.isNone(latest)
                    ? Option.map(Array.head(page.items), (revision) => revision.version)
                    : latest,
              }),
            },
            page.type,
          )
        : { model },
    FailedFetchHistory: ({ requested, failure }) =>
      sameRequest(requested, model.presentVersion)
        ? { model: modifyFields(model, { history: () => History.Failed({ failure }) }) }
        : { model },
    ClickedLoadMoreHistory: () =>
      Option.match(loadedHistory(model), {
        onNone: () => ({ model }),
        onSome: (history) =>
          Option.match(history.nextBefore, {
            onNone: () => ({ model }),
            onSome: (before) =>
              history.more._tag === "Loading"
                ? { model }
                : {
                    model: modifyFields(model, {
                      history: (current) => withHistoryMore(current, More.Loading()),
                    }),
                    commands: [
                      FetchMoreHistory({ id: model.id, version: model.presentVersion, before }),
                    ],
                  },
          }),
      }),
    SucceededFetchMoreHistory: ({ requested, page }) =>
      Option.match(
        Option.filter(loadedHistory(model), () => sameRequest(requested, model.presentVersion)),
        {
          onNone: () => ({ model }),
          onSome: (history) => ({
            model: modifyFields(model, {
              history: () =>
                History.Loaded({
                  type: history.type,
                  items: Array.appendAll(history.items, page.items),
                  failures: Array.appendAll(history.failures, page.failures),
                  nextBefore: page.nextBefore,
                  more: More.Idle(),
                }),
            }),
          }),
        },
      ),
    FailedFetchMoreHistory: ({ requested, failure }) =>
      sameRequest(requested, model.presentVersion)
        ? {
            model: modifyFields(model, {
              history: (history) => withHistoryMore(history, More.Failed({ failure })),
            }),
          }
        : { model },
    SelectedWriteVersion: ({ version }) => ({
      model: modifyFields(model, { editor: () => Editor.Loading({ version }) }),
      commands: [FetchEditBase({ id: model.id, version })],
    }),
    SucceededFetchEditBase: ({ entity }) =>
      model.editor._tag === "Loading" && model.editor.version === entity.version
        ? { model: modifyFields(model, { editor: () => editing(entity, model.type) }) }
        : { model },
    FailedFetchEditBase: ({ version, failure }) =>
      model.editor._tag === "Loading" && model.editor.version === version
        ? { model: modifyFields(model, { editor: () => Editor.Failed({ version, failure }) }) }
        : { model },
    GotEditorMessage: ({ message: formMessage }) => foldEditor(model, formMessage),
    GotDialogMessage: ({ message: dialogMessage }) => foldDialog(model, dialogMessage),
    SucceededFetchUsage: ({ consumers }) => ({
      model: modifyFields(model, { usage: () => Usage.Loaded({ usage: consumers.automations }) }),
    }),
    FailedFetchUsage: ({ failure }) => ({
      model: modifyFields(model, { usage: () => Usage.Failed({ failure }) }),
    }),
    ClickedConfirm: () =>
      Option.match(model.maybePending, {
        onNone: () => ({ model }),
        onSome: (pending) =>
          model.submission._tag === "Working" || isRefused(model, pending)
            ? { model }
            : {
                model: modifyFields(model, { submission: () => Submission.Working() }),
                commands: [
                  Pending.match(pending, {
                    Save: ({ write }) => WriteEntity({ write }),
                    Delete: ({ entity }) =>
                      DeleteEntity({ id: entity.id, type: entity.type, expectedRev: entity.rev }),
                  }),
                ],
              },
      }),
    SucceededSaveEntity: ({ entity }) => {
      const closed = closeDialog(
        modifyFields(model, {
          maybePending: () => Option.none(),
          submission: () => Submission.Idle(),
          maybeNotice: () => Option.some(`Saved as rev ${entity.rev}.`),
          editor: () => editing(entity, model.type),
        }),
      );
      const reloaded = reloadShown(closed.model);
      return {
        model: reloaded.model,
        commands: [...(closed.commands ?? []), ...(reloaded.commands ?? [])],
      };
    },
    FailedWrite: ({ failure }) => {
      const failed = {
        model: modifyFields(model, { submission: () => Submission.Failed({ failure }) }),
      };
      return Option.contains(failure.code, "EntityLinked") ? reloadBacklinks(failed) : failed;
    },
    ClickedReload: () => {
      const reloaded = reloadBacklinks(reloadShown(model));
      return Option.match(editorVersion(model.editor), {
        onNone: () => reloaded,
        onSome: (version) => ({
          model: modifyFields(reloaded.model, {
            editor: () => Editor.Loading({ version }),
            maybeNotice: () => Option.none(),
          }),
          commands: [...(reloaded.commands ?? []), FetchEditBase({ id: model.id, version })],
        }),
      });
    },
    ClickedDelete: () =>
      EntityState.match<UpdateReturn>(model.entity, {
        Loading: () => ({ model }),
        Failed: () => ({ model }),
        Loaded: ({ entity }) =>
          reloadBacklinks(
            propose(
              model,
              Pending.Delete({
                entity,
                proposal: entityDeleteProposal(entity, displayTitle(model)),
              }),
              entity.type,
            ),
          ),
      }),
    SucceededDeleteEntity: ({ type }) => {
      const closed = closeDialog(
        modifyFields(model, {
          maybePending: () => Option.none(),
          submission: () => Submission.Idle(),
        }),
      );
      return {
        model: closed.model,
        commands: [...(closed.commands ?? []), NavigateToType({ name: type })],
      };
    },
    ClickedDismissNotice: () => ({
      model: modifyFields(model, { maybeNotice: () => Option.none() }),
    }),
    CompletedNavigateToType: () => ({ model }),
  });

// VIEW

const opVariant = (op: Revision["op"]) =>
  op === "delete" ? "destructive" : op === "create" ? "default" : "secondary";

const revisionItem = (revision: Revision, h: HtmlBuilder<Message>): Html =>
  h.keyed("li")(
    `${revision.rev}`,
    [h.Class("rounded-lg border border-border")],
    [
      h.details(
        [],
        [
          h.summary(
            [
              h.Class(
                "flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm hover:bg-muted/50",
              ),
            ],
            [
              h.span([h.Class("font-mono text-xs font-semibold")], [`rev ${revision.rev}`]),
              badge({ variant: opVariant(revision.op) }, [revision.op], h),
              h.span(
                [h.Class("font-mono text-xs text-muted-foreground")],
                [`written as v${revision.writerVersion} · stored v${revision.storedVersion}`],
              ),
              h.span(
                [h.Class("ml-auto font-mono text-xs text-muted-foreground")],
                [formatTime(revision.createdAt)],
              ),
            ],
          ),
          h.div(
            [h.Class("border-t border-border p-3")],
            [
              jsonBlock(revision.data, h, {
                label: `Revision ${revision.rev} as v${revision.version}`,
              }),
            ],
          ),
        ],
      ),
    ],
  );

const historyView = (model: Model, h: HtmlBuilder<Message>): Html =>
  section(
    { title: "History" },
    [
      History.match(model.history, {
        Loading: () => statusText("Loading history…", h),
        Failed: ({ failure }) => failureAlert(failure, h),
        Loaded: ({ items, failures, nextBefore, more }) =>
          h.div(
            [h.Class("space-y-3")],
            [
              h.p(
                [h.Class("text-xs text-muted-foreground")],
                [
                  `Every write is kept. Snapshots are shown as ${Option.match(model.presentVersion, { onNone: () => "the latest version", onSome: (v) => `v${v}` })}; expand one to see its data.`,
                ],
              ),
              h.ul(
                [h.Class("space-y-2")],
                Array.map(items, (revision) => revisionItem(revision, h)),
              ),
              Array.match(failures, {
                onEmpty: () => h.empty,
                onNonEmpty: (nonEmpty) =>
                  h.ul(
                    [h.Class("space-y-1 text-xs text-destructive"), h.Role("alert")],
                    Array.map(nonEmpty, (failure) =>
                      h.keyed("li")(
                        `${failure.rev}`,
                        [],
                        [`rev ${failure.rev} can't be shown at this version: ${failure.error}`],
                      ),
                    ),
                  ),
              }),
              Option.match(nextBefore, {
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
                          onClick: Message.ClickedLoadMoreHistory(),
                          isDisabled: more._tag === "Loading",
                        },
                        more._tag === "Loading" ? "Loading…" : "Older revisions",
                        h,
                      ),
                      more._tag === "Failed" ? failureAlert(more.failure, h) : h.empty,
                    ],
                  ),
              }),
            ],
          ),
      }),
    ],
    h,
  );

const currentView = (model: Model, h: HtmlBuilder<Message>): Html =>
  section(
    { title: "Current data" },
    [
      EntityState.match(model.entity, {
        Loading: () => statusText("Loading entity…", h),
        Failed: ({ failure }) => failureAlert(failure, h),
        Loaded: ({ entity }) =>
          h.div(
            [h.Class("grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]")],
            [
              facts(
                [
                  ["Type", entity.type],
                  ["Rev", `${entity.rev}`],
                  ["Shown as", `v${entity.version}`],
                  ["Stored as", `v${entity.storedVersion}`],
                  ["Created", formatTime(entity.createdAt)],
                  ["Updated", formatTime(entity.updatedAt)],
                ],
                h,
              ),
              jsonBlock(entity.data, h, { label: `Data as v${entity.version}` }),
            ],
          ),
      }),
    ],
    h,
  );

const outgoingRow = (link: OutgoingLink, included: Included, h: HtmlBuilder<Message>): Html => {
  const target = Option.fromNullishOr(included[link.target]);
  return h.keyed("li")(
    `${link.path}:${link.target}`,
    [h.Class("grid gap-x-3 gap-y-0.5 text-sm sm:grid-cols-[12rem_minmax(0,1fr)]")],
    [
      h.code([h.Class("truncate font-mono text-xs text-muted-foreground")], [link.path]),
      h.div(
        [h.Class("flex min-w-0 flex-wrap items-baseline gap-x-2")],
        [
          entityLink(link.target, h),
          Option.match(target, {
            onNone: () =>
              h.span([h.Class("text-xs text-destructive")], [`${link.targetType} not found`]),
            onSome: (entity) =>
              h.span(
                [
                  h.Class("min-w-0 truncate text-xs text-muted-foreground"),
                  h.Title(preview(entity)),
                ],
                [`${entity.type} · ${preview(entity)}`],
              ),
          }),
        ],
      ),
    ],
  );
};

const linksView = (model: Model, h: HtmlBuilder<Message>): Html =>
  section(
    { title: "Links" },
    [
      EntityState.match(model.entity, {
        Loading: () => statusText("Loading entity…", h),
        Failed: () => statusText("The entity couldn't be read, so its links aren't shown.", h),
        Loaded: ({ entity, included }) =>
          TypeState.match(model.type, {
            Idle: () => statusText("Loading schema…", h),
            Loading: () => statusText("Loading schema…", h),
            Failed: ({ failure }) => failureAlert(failure, h),
            Loaded: ({ info }) =>
              Option.match(
                Array.findFirst(info.versions, (version) => version.version === entity.version),
                {
                  onNone: () => statusText(`No schema for v${entity.version}.`, h),
                  onSome: (version) =>
                    Array.match(outgoingLinks(version.schema, entity.data), {
                      onEmpty: () =>
                        statusText(`This entity has no links at v${entity.version}.`, h),
                      onNonEmpty: (links) =>
                        h.ul(
                          [h.Class("space-y-2"), h.AriaLabel("Outgoing links")],
                          Array.map(links, (link) => outgoingRow(link, included, h)),
                        ),
                    }),
                },
              ),
          }),
      }),
    ],
    h,
  );

const backlinksView = (model: Model, h: HtmlBuilder<Message>): Html =>
  section(
    { title: "Linked from" },
    [
      Backlinks.match(model.backlinks, {
        Loading: () => statusText("Loading backlinks…", h),
        Failed: ({ failure }) => failureAlert(failure, h),
        Loaded: ({ items, nextCursor, more }) =>
          h.div(
            [h.Class("space-y-3")],
            [
              Array.match(items, {
                onEmpty: () => statusText("Nothing links here.", h),
                onNonEmpty: (backlinks) =>
                  h.ul(
                    [h.Class("space-y-1"), h.AriaLabel("Backlinks")],
                    Array.map(backlinks, (backlink) =>
                      h.keyed("li")(
                        `${backlink.source}:${backlink.path}`,
                        [h.Class("flex flex-wrap items-baseline gap-x-2 text-sm")],
                        [
                          entityLink(backlink.source, h),
                          h.span(
                            [h.Class("font-mono text-xs text-muted-foreground")],
                            [`${backlink.type} · ${backlink.path}`],
                          ),
                        ],
                      ),
                    ),
                  ),
              }),
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
                          onClick: Message.ClickedLoadMoreBacklinks(),
                          isDisabled: more._tag === "Loading",
                        },
                        more._tag === "Loading" ? "Loading…" : "More backlinks",
                        h,
                      ),
                      more._tag === "Failed" ? failureAlert(more.failure, h) : h.empty,
                    ],
                  ),
              }),
            ],
          ),
      }),
    ],
    h,
  );

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

const conflictView = (model: Model, h: HtmlBuilder<Message>): Html =>
  model.submission._tag === "Failed" &&
  Option.contains(model.submission.failure.code, "RevConflict")
    ? h.div(
        [h.Class("flex flex-wrap items-center gap-3 text-sm")],
        [
          h.span(
            [],
            [
              `Someone else edited this entity${Option.match(model.submission.failure.currentRev, { onNone: () => "", onSome: (rev) => ` (now at rev ${rev})` })}. Reload to get their changes; this replaces your edits.`,
            ],
          ),
          button(
            { type: "button", size: "sm", variant: "outline", onClick: Message.ClickedReload() },
            "Reload",
            h,
          ),
        ],
      )
    : h.empty;

const deletionView = (h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("flex flex-wrap items-center gap-2 border-t border-border pt-4")],
    [
      button(
        { type: "button", variant: "destructive", onClick: Message.ClickedDelete() },
        "Delete entity",
        h,
      ),
    ],
  );

const editView = (model: Model, latest: number, h: HtmlBuilder<Message>): Html =>
  section(
    {
      title: "Edit",
      actions: [
        selectField(
          {
            id: "write-version",
            label: "Write as",
            value: `${Option.getOrElse(editorVersion(model.editor), () => latest)}`,
            options: versionOptions(latest),
            onChange: (value) => Message.SelectedWriteVersion({ version: Number(value) }),
            isDisabled: model.editor._tag === "Loading",
          },
          h,
        ),
      ],
    },
    [
      h.div(
        [h.Class("space-y-4")],
        [
          h.p(
            [h.Class("text-xs text-muted-foreground")],
            [
              "Edit in any schema version. Writing as an older version only changes the fields that version can see.",
            ],
          ),
          Editor.match(model.editor, {
            Idle: () => h.empty,
            Loading: ({ version }) => statusText(`Loading the entity as v${version}…`, h),
            Failed: ({ failure }) => failureAlert(failure, h),
            Waiting: () => statusText("Loading the schema…", h),
            Editing: ({ form }) =>
              h.submodel({
                slotId: "entity-editor",
                model: form,
                view: EntityForm.view,
                toParentMessage: (message) => Message.GotEditorMessage({ message }),
              }),
          }),
          deletionView(h),
        ],
      ),
    ],
    h,
  );

/** The loaded entity's title, from the schema of the version it's shown in. */
const displayTitle = (model: Model): Option.Option<string> =>
  EntityState.match(model.entity, {
    Loading: () => Option.none(),
    Failed: () => Option.none(),
    Loaded: ({ entity }) =>
      TypeState.match(model.type, {
        Idle: () => Option.none(),
        Loading: () => Option.none(),
        Failed: () => Option.none(),
        Loaded: ({ info }) =>
          Option.flatMap(
            Array.findFirst(info.versions, (version) => version.version === entity.version),
            (version) => entityTitle(version.schema, entity.data),
          ),
      }),
  });

export const view = Submodel.defineView<Model, Message>((model, h): Html =>
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
            ...Option.match(typeName(model), {
              onNone: () => [],
              onSome: (name) => [
                h.a(
                  [
                    h.Href(href(AppRoute.TypeDetail({ name }))),
                    h.Class("underline-offset-4 hover:underline"),
                  ],
                  [name],
                ),
                " / ",
              ],
            }),
          ],
          ...Option.match(displayTitle(model), {
            onNone: () => ({ title: model.id }),
            onSome: (title) => ({ title, description: model.id }),
          }),
          actions: Option.match(model.latestVersion, {
            onNone: () => [],
            onSome: (latest) => [
              selectField(
                {
                  id: "present-version",
                  label: "Show as",
                  value: `${Option.getOrElse(model.presentVersion, () => latest)}`,
                  options: versionOptions(latest),
                  onChange: (value) => Message.SelectedPresentVersion({ version: Number(value) }),
                },
                h,
              ),
            ],
          }),
        },
        h,
      ),
      noticeView(model, h),
      currentView(model, h),
      h.div([h.Class("grid gap-6 lg:grid-cols-2")], [linksView(model, h), backlinksView(model, h)]),
      EntityState.match(model.entity, {
        Loading: () => h.empty,
        Failed: () => h.empty,
        Loaded: ({ entity }) =>
          editView(
            model,
            Option.getOrElse(model.latestVersion, () => entity.version),
            h,
          ),
      }),
      historyView(model, h),
      confirmDialog(
        {
          dialog: model.dialog,
          maybeProposal: Option.map(model.maybePending, (pending) => proposalOf(model, pending)),
          usage: model.usage,
          submission: model.submission,
          maybeChecking: Option.flatMap(model.maybePending, (pending) =>
            pending._tag === "Delete" && model.backlinks._tag === "Loading"
              ? Option.some("Checking who links to it…")
              : Option.none(),
          ),
          onConfirm: Message.ClickedConfirm(),
          toDialogMessage,
        },
        h,
      ),
      conflictView(model, h),
    ],
  ),
);
