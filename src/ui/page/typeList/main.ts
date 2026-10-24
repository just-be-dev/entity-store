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
import { apiUrl, getJson, postJson } from "@/api";
import { Proposal, Submission, Usage, confirmDialog, initDialog } from "@/components/confirm";
import { failureAlert } from "@/components/feedback";
import { pageHeader, section, statusText } from "@/components/layout";
import * as TypeForm from "@/components/typeForm/main";
import { badge } from "@/components/ui/badge";
import * as Dialog from "@/components/ui/dialog";
import { Empty } from "@/components/ui/empty";
import { Impact } from "@/domain/consequences";
import { ApiFailure, TypeInfo, TypeList, TypeSummary } from "@/domain/entityStore";
import { formatTime } from "@/lib/format";
import { AppRoute, href } from "@/route";
import { EntitySchema } from "../../../schema/model.ts";

// MODEL

export const Types = defineTaggedUnion({
  Loading: {},
  Failed: { failure: ApiFailure },
  Loaded: { items: Schema.Array(TypeSummary) },
});
export type Types = typeof Types.Type;

/** A new type waiting for confirmation. */
export const PendingType = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  schema: EntitySchema,
  proposal: Proposal,
});
export type PendingType = typeof PendingType.Type;

export const Model = Schema.Struct({
  types: Types,
  form: TypeForm.Model,
  dialog: Dialog.Model,
  maybePending: Schema.Option(PendingType),
  submission: Submission,
});
export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  SucceededFetchTypes: { items: Schema.Array(TypeSummary) },
  FailedFetchTypes: { failure: ApiFailure },
  GotFormMessage: { message: TypeForm.Message },
  GotDialogMessage: { message: Dialog.Message },
  ClickedConfirm: {},
  SucceededCreateType: { name: Schema.String },
  FailedCreateType: { failure: ApiFailure },
  CompletedNavigateToType: {},
});
export type Message = typeof Message.Type;

// OUT MESSAGE

export const OutMessage = defineMessageUnion({
  CreatedType: { name: Schema.String },
});
export type OutMessage = typeof OutMessage.Type;

// COMMAND

export const FetchTypes = Command.define("FetchTypes", {
  messages: [Message.SucceededFetchTypes, Message.FailedFetchTypes],
  execute: getJson(apiUrl("types"), TypeList).pipe(
    Effect.map(({ items }) => Message.SucceededFetchTypes({ items })),
    Effect.catch((failure) => Effect.succeed(Message.FailedFetchTypes({ failure }))),
  ),
});

export const CreateType = Command.define("CreateType", {
  args: { name: Schema.String, description: Schema.String, schema: EntitySchema },
  messages: [Message.SucceededCreateType, Message.FailedCreateType],
  execute: ({ name, description, schema }) =>
    postJson(apiUrl("types"), { name, description, schema }, TypeInfo).pipe(
      Effect.map((info) => Message.SucceededCreateType({ name: info.name })),
      Effect.catch((failure) => Effect.succeed(Message.FailedCreateType({ failure }))),
    ),
});

export const NavigateToType = Command.define("NavigateToType", {
  args: { name: Schema.String },
  messages: [Message.CompletedNavigateToType],
  execute: ({ name }) =>
    pushUrl(href(AppRoute.TypeDetail({ name }))).pipe(Effect.as(Message.CompletedNavigateToType())),
});

// INIT

export const init = (): Update.Return<Model, Message> => ({
  model: Model.make({
    types: Types.Loading(),
    form: TypeForm.initCreate([]),
    dialog: initDialog(),
    maybePending: Option.none(),
    submission: Submission.Idle(),
  }),
  commands: [FetchTypes()],
});

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>;

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

const foldFormTargets = Update.foldChild({
  update: TypeForm.withTargets,
  read: (model: Model) => Option.some(model.form),
  write: (model: Model, nextForm: TypeForm.Model) => modifyFields(model, { form: () => nextForm }),
  toParentMessage: (message: TypeForm.Message) => Message.GotFormMessage({ message }),
});

const foldForm = Update.foldChild({
  update: TypeForm.update,
  read: (model: Model) => Option.some(model.form),
  write: (model: Model, nextForm: TypeForm.Model) => modifyFields(model, { form: () => nextForm }),
  toParentMessage: (message: TypeForm.Message) => Message.GotFormMessage({ message }),
  foldOutMessage: (outMessage) =>
    TypeForm.OutMessage.match(outMessage, {
      SubmittedNewType: ({ name, description, schema, details }) =>
        Update.combine([
          (stepModel: Model) => ({
            model: modifyFields(stepModel, {
              maybePending: () =>
                Option.some(
                  PendingType.make({
                    name,
                    description,
                    schema,
                    proposal: Proposal.make({
                      title: `Create ${name}`,
                      summary: `A new entity type at v1${description === "" ? "" : `: ${description}`}.`,
                      confirmLabel: "Create type",
                      isDestructive: false,
                      details,
                      notes: [],
                      refusals: [],
                      impact: Impact.TypeSave({
                        type: name,
                        isNew: true,
                        renamed: [],
                        removed: [],
                      }),
                    }),
                  }),
                ),
              submission: () => Submission.Idle(),
            }),
          }),
          openDialog,
        ]),
      SubmittedVersion: () => (stepModel: Model) => ({ model: stepModel }),
      Cancelled: () => (stepModel: Model) => ({ model: stepModel }),
    }),
});

/** For a new type there's nobody to ask: nothing can use it yet. */
const newTypeUsage = Usage.Loaded({
  usage: { status: "checked", watching: [], listening: [], templateSlots: [], unchecked: [] },
});

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    SucceededFetchTypes: ({ items }) =>
      foldFormTargets(
        modifyFields(model, { types: () => Types.Loaded({ items }) }),
        Array.map(items, (type) => type.name),
      ),
    FailedFetchTypes: ({ failure }) => ({
      model: modifyFields(model, { types: () => Types.Failed({ failure }) }),
    }),
    GotFormMessage: ({ message: formMessage }) => foldForm(model, formMessage),
    GotDialogMessage: ({ message: dialogMessage }) => foldDialog(model, dialogMessage),
    ClickedConfirm: () =>
      Option.match(model.maybePending, {
        onNone: () => ({ model }),
        onSome: (pending) =>
          model.submission._tag === "Working"
            ? { model }
            : {
                model: modifyFields(model, { submission: () => Submission.Working() }),
                commands: [
                  CreateType({
                    name: pending.name,
                    description: pending.description,
                    schema: pending.schema,
                  }),
                ],
              },
      }),
    SucceededCreateType: ({ name }) => {
      const closed = closeDialog(
        modifyFields(model, {
          maybePending: () => Option.none(),
          submission: () => Submission.Idle(),
        }),
      );
      return {
        model: closed.model,
        commands: [...(closed.commands ?? []), NavigateToType({ name })],
        outMessage: OutMessage.CreatedType({ name }),
      };
    },
    FailedCreateType: ({ failure }) => ({
      model: modifyFields(model, { submission: () => Submission.Failed({ failure }) }),
    }),
    CompletedNavigateToType: () => ({ model }),
  });

// VIEW

const typeRow = (type: TypeSummary, h: HtmlBuilder<Message>): Html =>
  h.keyed("tr")(
    type.name,
    [h.Class("border-t border-border align-top")],
    [
      h.td(
        [h.Class("py-2 pr-4")],
        [
          h.a(
            [
              h.Href(href(AppRoute.TypeDetail({ name: type.name }))),
              h.Class("font-mono font-medium text-primary underline-offset-4 hover:underline"),
            ],
            [type.name],
          ),
        ],
      ),
      h.td([h.Class("py-2 pr-4 text-muted-foreground")], [type.description || "—"]),
      h.td(
        [h.Class("py-2 pr-4")],
        [badge({ variant: "secondary" }, [`v${type.latestVersion}`], h)],
      ),
      h.td(
        [h.Class("hidden py-2 font-mono text-xs text-muted-foreground sm:table-cell")],
        [formatTime(type.updatedAt)],
      ),
    ],
  );

const typesTable = (items: ReadonlyArray<TypeSummary>, h: HtmlBuilder<Message>): Html =>
  Array.match(items, {
    onEmpty: () =>
      Empty(
        {},
        [
          Empty.header(
            {},
            [
              Empty.title({}, ["No entity types yet"], h),
              Empty.description({}, ["Define one below to create the first."], h),
            ],
            h,
          ),
        ],
        h,
      ),
    onNonEmpty: (types) =>
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
                      h.th([h.Class("pb-2 pr-4 font-medium"), h.Scope("col")], ["Name"]),
                      h.th([h.Class("pb-2 pr-4 font-medium"), h.Scope("col")], ["Description"]),
                      h.th([h.Class("pb-2 pr-4 font-medium"), h.Scope("col")], ["Latest"]),
                      h.th(
                        [h.Class("hidden pb-2 font-medium sm:table-cell"), h.Scope("col")],
                        ["Updated"],
                      ),
                    ],
                  ),
                ],
              ),
              h.tbody(
                [],
                Array.map(types, (type) => typeRow(type, h)),
              ),
            ],
          ),
        ],
      ),
  });

export const view = Submodel.defineView<Model, Message>((model, h): Html =>
  h.div(
    [h.Class("space-y-6")],
    [
      pageHeader(
        {
          title: "Entity types",
          description:
            "Each type has versioned schemas. Entities of every type live in one table; lenses translate between versions on read.",
        },
        h,
      ),
      section(
        { title: "Types" },
        [
          Types.match(model.types, {
            Loading: () => statusText("Loading types…", h),
            Failed: ({ failure }) => failureAlert(failure, h),
            Loaded: ({ items }) => typesTable(items, h),
          }),
        ],
        h,
      ),
      section(
        { title: "New type" },
        [
          h.submodel({
            slotId: "new-type-form",
            model: model.form,
            view: TypeForm.view,
            toParentMessage: (message) => Message.GotFormMessage({ message }),
          }),
        ],
        h,
      ),
      confirmDialog(
        {
          dialog: model.dialog,
          maybeProposal: Option.map(model.maybePending, (pending) => pending.proposal),
          usage: newTypeUsage,
          submission: model.submission,
          onConfirm: Message.ClickedConfirm(),
          toDialogMessage,
        },
        h,
      ),
    ],
  ),
);
