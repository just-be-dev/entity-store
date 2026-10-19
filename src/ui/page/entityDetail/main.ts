import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Command, Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { pushUrl } from "foldkit/navigation";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";
import type * as Update from "foldkit/update";
import { apiUrl, deleteJson, getJson, putJson, segment } from "@/api";
import { errorAlert, failureAlert, successAlert } from "@/components/feedback";
import { jsonBlock } from "@/components/json";
import { facts, pageHeader, section, statusText } from "@/components/layout";
import { selectField, versionOptions } from "@/components/select";
import { badge } from "@/components/ui/badge";
import { button } from "@/components/ui/button";
import { textarea } from "@/components/ui/textarea";
import {
  ApiFailure,
  Deleted,
  Entity,
  HistoryPage,
  Revision,
  RevisionFailure,
} from "@/domain/entityStore";
import { parseJson, prettyJson } from "@/domain/json";
import { formatTime } from "@/lib/format";
import { AppRoute, href } from "@/route";

// MODEL

export const EntityState = defineTaggedUnion({
  Loading: {},
  Failed: { failure: ApiFailure },
  Loaded: { entity: Entity },
});
export type EntityState = typeof EntityState.Type;

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

export const Save = defineTaggedUnion({
  Idle: {},
  Saving: {},
  Invalid: { message: Schema.String },
  Conflict: { currentRev: Schema.Option(Schema.Int) },
  Failed: { failure: ApiFailure },
  Saved: { rev: Schema.Int },
});
export type Save = typeof Save.Type;

export const Editor = defineTaggedUnion({
  Idle: {},
  Loading: { version: Schema.Int },
  Failed: { version: Schema.Int, failure: ApiFailure },
  Editing: { version: Schema.Int, baseRev: Schema.Int, text: Schema.String, save: Save },
});
export type Editor = typeof Editor.Type;

export const Deletion = defineTaggedUnion({
  Idle: {},
  Confirming: {},
  Deleting: {},
  Failed: { failure: ApiFailure },
});
export type Deletion = typeof Deletion.Type;

export const Model = Schema.Struct({
  id: Schema.String,
  presentVersion: Schema.Option(Schema.Int),
  latestVersion: Schema.Option(Schema.Int),
  entity: EntityState,
  history: History,
  editor: Editor,
  deletion: Deletion,
});
export type Model = typeof Model.Type;

// MESSAGE

const Requested = Schema.Option(Schema.Int);

export const Message = defineMessageUnion({
  SucceededFetchEntity: { requested: Requested, entity: Entity },
  FailedFetchEntity: { requested: Requested, failure: ApiFailure },
  SelectedPresentVersion: { version: Schema.Int },
  SucceededFetchHistory: { requested: Requested, page: HistoryPage },
  FailedFetchHistory: { requested: Requested, failure: ApiFailure },
  ClickedLoadMoreHistory: {},
  SucceededFetchMoreHistory: { requested: Requested, page: HistoryPage },
  FailedFetchMoreHistory: { requested: Requested, failure: ApiFailure },
  SelectedWriteVersion: { version: Schema.Int },
  SucceededFetchEditBase: { entity: Entity },
  FailedFetchEditBase: { version: Schema.Int, failure: ApiFailure },
  UpdatedEditText: { value: Schema.String },
  ClickedSave: {},
  SucceededSaveEntity: { entity: Entity },
  FailedSaveEntity: { failure: ApiFailure },
  ClickedReload: {},
  ClickedDelete: {},
  ClickedCancelDelete: {},
  ClickedConfirmDelete: {},
  SucceededDeleteEntity: { type: Schema.String },
  FailedDeleteEntity: { failure: ApiFailure },
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
    getJson(apiUrl(`entities/${segment(id)}`, versionQuery(version)), Entity).pipe(
      Effect.map((entity) => Message.SucceededFetchEntity({ requested: version, entity })),
      Effect.catch((failure) =>
        Effect.succeed(Message.FailedFetchEntity({ requested: version, failure })),
      ),
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

export const SaveEntity = Command.define("SaveEntity", {
  args: { id: Schema.String, version: Schema.Int, data: Schema.Json, expectedRev: Schema.Int },
  messages: [Message.SucceededSaveEntity, Message.FailedSaveEntity],
  execute: ({ id, version, data, expectedRev }) =>
    putJson(apiUrl(`entities/${segment(id)}`), { version, data, expectedRev }, Entity).pipe(
      Effect.map((entity) => Message.SucceededSaveEntity({ entity })),
      Effect.catch((failure) => Effect.succeed(Message.FailedSaveEntity({ failure }))),
    ),
});

export const DeleteEntity = Command.define("DeleteEntity", {
  args: { id: Schema.String, type: Schema.String, expectedRev: Schema.Int },
  messages: [Message.SucceededDeleteEntity, Message.FailedDeleteEntity],
  execute: ({ id, type, expectedRev }) =>
    deleteJson(apiUrl(`entities/${segment(id)}`, { expectedRev: `${expectedRev}` }), Deleted).pipe(
      Effect.as(Message.SucceededDeleteEntity({ type })),
      Effect.catch((failure) => Effect.succeed(Message.FailedDeleteEntity({ failure }))),
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
    history: History.Loading(),
    editor: Editor.Idle(),
    deletion: Deletion.Idle(),
  }),
  commands: [
    FetchEntity({ id, version: Option.none() }),
    FetchHistory({ id, version: Option.none() }),
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

const editing = (entity: Entity, save: Save): Editor =>
  Editor.Editing({
    version: entity.version,
    baseRev: entity.rev,
    text: prettyJson(entity.data),
    save,
  });

const withSave = (editor: Editor, save: Save): Editor =>
  editor._tag === "Editing" ? Editor.Editing({ ...editor, save }) : editor;

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
    Editing: ({ version }) => Option.some(version),
  });

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    SucceededFetchEntity: ({ requested, entity }) =>
      sameRequest(requested, model.presentVersion)
        ? {
            model: modifyFields(model, {
              entity: () => EntityState.Loaded({ entity }),
              latestVersion: (latest) =>
                Option.isNone(requested) ? Option.some(entity.version) : latest,
              editor: (editor) => (editor._tag === "Idle" ? editing(entity, Save.Idle()) : editor),
            }),
          }
        : { model },
    FailedFetchEntity: ({ requested, failure }) =>
      sameRequest(requested, model.presentVersion)
        ? { model: modifyFields(model, { entity: () => EntityState.Failed({ failure }) }) }
        : { model },
    SelectedPresentVersion: ({ version }) =>
      reloadShown(modifyFields(model, { presentVersion: () => Option.some(version) })),
    SucceededFetchHistory: ({ requested, page }) =>
      sameRequest(requested, model.presentVersion)
        ? {
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
          }
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
        ? { model: modifyFields(model, { editor: () => editing(entity, Save.Idle()) }) }
        : { model },
    FailedFetchEditBase: ({ version, failure }) =>
      model.editor._tag === "Loading" && model.editor.version === version
        ? { model: modifyFields(model, { editor: () => Editor.Failed({ version, failure }) }) }
        : { model },
    UpdatedEditText: ({ value }) => ({
      model: modifyFields(model, {
        editor: (editor) =>
          editor._tag === "Editing" ? Editor.Editing({ ...editor, text: value }) : editor,
      }),
    }),
    ClickedSave: () =>
      Editor.match<UpdateReturn>(model.editor, {
        Idle: () => ({ model }),
        Loading: () => ({ model }),
        Failed: () => ({ model }),
        Editing: (editor) =>
          editor.save._tag === "Saving"
            ? { model }
            : Result.match(parseJson(editor.text), {
                onFailure: (error) => ({
                  model: modifyFields(model, {
                    editor: () =>
                      withSave(
                        editor,
                        Save.Invalid({ message: `Data isn't valid JSON: ${error}` }),
                      ),
                  }),
                }),
                onSuccess: (data) => ({
                  model: modifyFields(model, { editor: () => withSave(editor, Save.Saving()) }),
                  commands: [
                    SaveEntity({
                      id: model.id,
                      version: editor.version,
                      data,
                      expectedRev: editor.baseRev,
                    }),
                  ],
                }),
              }),
      }),
    SucceededSaveEntity: ({ entity }) =>
      reloadShown(
        modifyFields(model, { editor: () => editing(entity, Save.Saved({ rev: entity.rev })) }),
      ),
    FailedSaveEntity: ({ failure }) => ({
      model: modifyFields(model, {
        editor: (editor) =>
          withSave(
            editor,
            Option.contains(failure.code, "RevConflict")
              ? Save.Conflict({ currentRev: failure.currentRev })
              : Save.Failed({ failure }),
          ),
      }),
    }),
    ClickedReload: () => {
      const reloaded = reloadShown(model);
      return Option.match(editorVersion(model.editor), {
        onNone: () => reloaded,
        onSome: (version) => ({
          model: modifyFields(reloaded.model, { editor: () => Editor.Loading({ version }) }),
          commands: [...(reloaded.commands ?? []), FetchEditBase({ id: model.id, version })],
        }),
      });
    },
    ClickedDelete: () => ({
      model: modifyFields(model, { deletion: () => Deletion.Confirming() }),
    }),
    ClickedCancelDelete: () => ({
      model: modifyFields(model, { deletion: () => Deletion.Idle() }),
    }),
    ClickedConfirmDelete: () =>
      EntityState.match<UpdateReturn>(model.entity, {
        Loading: () => ({ model }),
        Failed: () => ({ model }),
        Loaded: ({ entity }) =>
          model.deletion._tag === "Deleting"
            ? { model }
            : {
                model: modifyFields(model, { deletion: () => Deletion.Deleting() }),
                commands: [
                  DeleteEntity({ id: model.id, type: entity.type, expectedRev: entity.rev }),
                ],
              },
      }),
    SucceededDeleteEntity: ({ type }) => ({
      model,
      commands: [NavigateToType({ name: type })],
    }),
    FailedDeleteEntity: ({ failure }) => ({
      model: modifyFields(model, { deletion: () => Deletion.Failed({ failure }) }),
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

const saveView = (save: Save, h: HtmlBuilder<Message>): Html =>
  Save.match(save, {
    Idle: () => h.empty,
    Saving: () => statusText("Saving…", h),
    Invalid: ({ message }) => errorAlert(message, h),
    Conflict: ({ currentRev }) =>
      h.div(
        [
          h.Class(
            "flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive",
          ),
          h.Role("alert"),
        ],
        [
          h.span(
            [],
            [
              `Someone else edited this entity${Option.match(currentRev, { onNone: () => "", onSome: (rev) => ` (now at rev ${rev})` })} while you were working. Reload to get their changes; this replaces your edits.`,
            ],
          ),
          button(
            { type: "button", size: "sm", variant: "outline", onClick: Message.ClickedReload() },
            "Reload",
            h,
          ),
        ],
      ),
    Failed: ({ failure }) => failureAlert(failure, h),
    Saved: ({ rev }) => successAlert([`Saved as rev ${rev}.`], h),
  });

const editorForm = (
  editor: Extract<Editor, { readonly _tag: "Editing" }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.form(
    [h.OnSubmit(Message.ClickedSave()), h.Class("space-y-3"), h.AriaLabel("Edit entity")],
    [
      textarea(
        {
          id: "edit-data",
          label: `Data as v${editor.version} (JSON)`,
          description: `Saves with expectedRev ${editor.baseRev}, so concurrent edits aren't overwritten.`,
          value: editor.text,
          rows: 12,
          onInput: (value) => Message.UpdatedEditText({ value }),
          className: "max-h-[32rem] font-mono text-xs",
        },
        h,
      ),
      saveView(editor.save, h),
      button(
        { type: "submit", isDisabled: editor.save._tag === "Saving" },
        editor.save._tag === "Saving" ? "Saving…" : "Save",
        h,
      ),
    ],
  );

const deletionView = (deletion: Deletion, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("flex flex-wrap items-center gap-2 border-t border-border pt-4")],
    Deletion.match(deletion, {
      Idle: () => [
        button(
          { type: "button", variant: "destructive", onClick: Message.ClickedDelete() },
          "Delete entity",
          h,
        ),
      ],
      Confirming: () => [
        h.span([h.Class("text-sm")], ["Delete this entity? Its history is kept."]),
        button(
          { type: "button", variant: "destructive", onClick: Message.ClickedConfirmDelete() },
          "Yes, delete",
          h,
        ),
        button(
          { type: "button", variant: "ghost", onClick: Message.ClickedCancelDelete() },
          "Cancel",
          h,
        ),
      ],
      Deleting: () => [statusText("Deleting…", h)],
      Failed: ({ failure }) => [
        failureAlert(failure, h),
        button(
          { type: "button", variant: "destructive", onClick: Message.ClickedConfirmDelete() },
          "Retry delete",
          h,
        ),
      ],
    }),
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
            Editing: (editor) => editorForm(editor, h),
          }),
          deletionView(model.deletion, h),
        ],
      ),
    ],
    h,
  );

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
          title: model.id,
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
      currentView(model, h),
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
    ],
  ),
);
