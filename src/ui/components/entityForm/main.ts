import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
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
import { errorAlert, failureAlert } from "@/components/feedback";
import { statusText } from "@/components/layout";
import { selectClass } from "@/components/select";
import { button } from "@/components/ui/button";
import { inputClass, inputDescriptionClass, inputLabelClass } from "@/components/ui/input";
import { textarea, textareaClass } from "@/components/ui/textarea";
import {
  type FormField,
  InputKind,
  formFields,
  idProblem,
  patchOf,
  textsOf,
} from "@/domain/entityDraft";
import { ApiFailure, Entity, EntityCheck } from "@/domain/entityStore";
import { parseJson, prettyJson } from "@/domain/json";
import { cn } from "@/lib/utils";
import { compiled } from "../../../schema/compile.ts";
import { EntitySchema } from "../../../schema/model.ts";

// The entity form: one typed input per field of the version it writes, an ID
// for new entities (checked as it's typed and against the store), and raw
// JSON as an escape hatch. Submitting checks every value, then dry-runs the
// write on the server, and hands the parent a prepared write to confirm.
// The parent owns the confirmation and the write itself.

// MODEL

export const Mode = defineTaggedUnion({
  Create: {},
  Edit: { id: Schema.String, rev: Schema.Int, data: Schema.Json },
});
export type Mode = typeof Mode.Type;

/** Whether a new entity's ID can be used, as far as the store said when asked. */
export const IdCheck = defineTaggedUnion({
  Idle: {},
  Checking: { id: Schema.String },
  Free: { id: Schema.String },
  WasDeleted: { id: Schema.String },
  Taken: { id: Schema.String, type: Schema.String },
  Failed: { id: Schema.String, failure: ApiFailure },
});
export type IdCheck = typeof IdCheck.Type;

export const Editor = defineTaggedUnion({
  Fields: {},
  Json: { text: Schema.String },
});
export type Editor = typeof Editor.Type;

export const FieldError = Schema.Struct({ field: Schema.String, message: Schema.String });
export type FieldError = typeof FieldError.Type;

export const Stage = defineTaggedUnion({
  Editing: {},
  Invalid: { message: Schema.String, errors: Schema.Array(FieldError) },
  Checking: {},
  Failed: { failure: ApiFailure },
});
export type Stage = typeof Stage.Type;

export const Model = Schema.Struct({
  type: Schema.String,
  version: Schema.Int,
  schema: EntitySchema,
  mode: Mode,
  idText: Schema.String,
  idCheck: IdCheck,
  values: Schema.Record(Schema.String, Schema.String),
  initial: Schema.Record(Schema.String, Schema.String),
  editor: Editor,
  stage: Stage,
});
export type Model = typeof Model.Type;

/** A write the form checked, ready to confirm. `before` and `after` are at `version`. */
export const PreparedWrite = defineTaggedUnion({
  Upsert: {
    type: Schema.String,
    id: Schema.String,
    version: Schema.Int,
    patch: Schema.Record(Schema.String, Schema.Json),
    expectedRev: Schema.Int,
    before: Schema.Json,
    after: Schema.Json,
    created: Schema.Boolean,
  },
  /** A new entity whose ID the store picks. */
  Create: { type: Schema.String, version: Schema.Int, data: Schema.Json },
  /** A whole document from the JSON editor. */
  Replace: {
    type: Schema.String,
    id: Schema.String,
    version: Schema.Int,
    data: Schema.Json,
    expectedRev: Schema.Int,
    before: Schema.Json,
  },
});
export type PreparedWrite = typeof PreparedWrite.Type;

// MESSAGE

export const Message = defineMessageUnion({
  UpdatedId: { value: Schema.String },
  CommittedId: { value: Schema.String },
  SucceededCheckId: { id: Schema.String, entity: Entity },
  FailedCheckId: { id: Schema.String, failure: ApiFailure },
  UpdatedField: { name: Schema.String, value: Schema.String },
  ClickedEditJson: {},
  ClickedEditFields: {},
  UpdatedJson: { value: Schema.String },
  SubmittedForm: {},
  SucceededCheckWrite: { check: EntityCheck },
  FailedCheckWrite: { failure: ApiFailure },
  ClickedCancel: {},
});
export type Message = typeof Message.Type;

export const OutMessage = defineMessageUnion({
  PreparedWrite: { write: PreparedWrite },
  Cancelled: {},
});
export type OutMessage = typeof OutMessage.Type;

// COMMAND

export const CheckId = Command.define("CheckId", {
  args: { id: Schema.String },
  messages: [Message.SucceededCheckId, Message.FailedCheckId],
  execute: ({ id }) =>
    getJson(apiUrl(`entities/${segment(id)}`), Entity).pipe(
      Effect.map((entity) => Message.SucceededCheckId({ id, entity })),
      Effect.catch((failure) => Effect.succeed(Message.FailedCheckId({ id, failure }))),
    ),
});

export const CheckWrite = Command.define("CheckWrite", {
  args: {
    type: Schema.String,
    id: Schema.String,
    version: Schema.Int,
    patch: Schema.Record(Schema.String, Schema.Json),
  },
  messages: [Message.SucceededCheckWrite, Message.FailedCheckWrite],
  execute: ({ type, id, version, patch }) =>
    postJson(
      apiUrl(`types/${segment(type)}/entities/${segment(id)}/check`),
      { version, patch },
      EntityCheck,
    ).pipe(
      Effect.map((check) => Message.SucceededCheckWrite({ check })),
      Effect.catch((failure) => Effect.succeed(Message.FailedCheckWrite({ failure }))),
    ),
});

// INIT

const fieldsOf = (model: Model) => formFields(model.schema);

/** A form for a new entity of `type`, written as `version`. */
export const initCreate = (type: string, version: number, schema: EntitySchema): Model => {
  const values = textsOf(formFields(schema), {});
  return Model.make({
    type,
    version,
    schema,
    mode: Mode.Create(),
    idText: "",
    idCheck: IdCheck.Idle(),
    values,
    initial: values,
    editor: Editor.Fields(),
    stage: Stage.Editing(),
  });
};

/** A form editing `entity`, whose data is presented at `version` (its `entity.version`). */
export const initEdit = (entity: Entity, schema: EntitySchema): Model => {
  const values = textsOf(formFields(schema), entity.data);
  return Model.make({
    type: entity.type,
    version: entity.version,
    schema,
    mode: Mode.Edit({ id: entity.id, rev: entity.rev, data: entity.data }),
    idText: entity.id,
    idCheck: IdCheck.Idle(),
    values,
    initial: values,
    editor: Editor.Fields(),
    stage: Stage.Editing(),
  });
};

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>;

const invalid = (model: Model, message: string, errors: ReadonlyArray<FieldError> = []) => ({
  model: modifyFields(model, { stage: () => Stage.Invalid({ message, errors }) }),
});

const before = (model: Model): Schema.Json =>
  Mode.match(model.mode, { Create: () => ({}), Edit: ({ data }) => data });

const isTaken = (check: IdCheck, id: string) => check._tag === "Taken" && check.id === id;

const submitFields = (model: Model): UpdateReturn => {
  const id = model.idText.trim();
  const isCreate = model.mode._tag === "Create";
  if (isCreate && String.isNonEmpty(id)) {
    const problem = idProblem(id);
    if (Option.isSome(problem)) {
      return invalid(model, problem.value);
    }
    if (isTaken(model.idCheck, id)) {
      return invalid(model, `${id} is taken. Choose another ID.`);
    }
  }
  return Result.match(
    patchOf(fieldsOf(model), model.values, model.initial, isCreate ? "create" : "edit"),
    {
      onFailure: (errors) =>
        invalid(
          model,
          errors.length === 1
            ? "One field can't be saved."
            : `${errors.length} fields can't be saved.`,
          errors,
        ),
      onSuccess: (patch) =>
        Mode.match<UpdateReturn>(model.mode, {
          Create: () =>
            String.isEmpty(id)
              ? {
                  model: modifyFields(model, { stage: () => Stage.Editing() }),
                  outMessage: OutMessage.PreparedWrite({
                    write: PreparedWrite.Create({
                      type: model.type,
                      version: model.version,
                      data: patch,
                    }),
                  }),
                }
              : {
                  model: modifyFields(model, { stage: () => Stage.Checking() }),
                  commands: [CheckWrite({ type: model.type, id, version: model.version, patch })],
                },
          Edit: ({ id: editId }) =>
            Record.isEmptyRecord(patch)
              ? invalid(model, "Nothing changed.")
              : {
                  model: modifyFields(model, { stage: () => Stage.Checking() }),
                  commands: [
                    CheckWrite({ type: model.type, id: editId, version: model.version, patch }),
                  ],
                },
        }),
    },
  );
};

const submitJson = (model: Model, text: string): UpdateReturn =>
  Result.match(parseJson(text), {
    onFailure: (message) => invalid(model, `The data isn't valid JSON: ${message}`),
    onSuccess: (data) =>
      Result.match(compiled(model.schema).validate(data), {
        onFailure: (message) =>
          invalid(model, `The data doesn't match v${model.version}: ${message}`),
        onSuccess: () =>
          Mode.match<UpdateReturn>(model.mode, {
            Create: () => {
              const id = model.idText.trim();
              const problem = String.isEmpty(id) ? Option.none() : idProblem(id);
              return Option.match(problem, {
                onSome: (message) => invalid(model, message),
                onNone: () =>
                  String.isEmpty(id)
                    ? {
                        model: modifyFields(model, { stage: () => Stage.Editing() }),
                        outMessage: OutMessage.PreparedWrite({
                          write: PreparedWrite.Create({
                            type: model.type,
                            version: model.version,
                            data,
                          }),
                        }),
                      }
                    : typeof data === "object" && data !== null && !globalThis.Array.isArray(data)
                      ? {
                          model: modifyFields(model, { stage: () => Stage.Checking() }),
                          commands: [
                            CheckWrite({
                              type: model.type,
                              id,
                              version: model.version,
                              patch: data as Readonly<Record<string, Schema.Json>>,
                            }),
                          ],
                        }
                      : invalid(model, "The data must be an object."),
              });
            },
            Edit: ({ id, rev, data: stored }) => ({
              model: modifyFields(model, { stage: () => Stage.Editing() }),
              outMessage: OutMessage.PreparedWrite({
                write: PreparedWrite.Replace({
                  type: model.type,
                  id,
                  version: model.version,
                  data,
                  expectedRev: rev,
                  before: stored,
                }),
              }),
            }),
          }),
      }),
  });

/** The patch the last submit dry-ran, rebuilt from the same inputs. */
const submittedPatch = (model: Model): Readonly<Record<string, Schema.Json>> =>
  Editor.match(model.editor, {
    Fields: () =>
      Result.getOrElse(
        patchOf(
          fieldsOf(model),
          model.values,
          model.initial,
          model.mode._tag === "Create" ? "create" : "edit",
        ),
        () => ({}),
      ),
    Json: ({ text }) =>
      Result.match(parseJson(text), {
        onFailure: () => ({}),
        onSuccess: (data) =>
          typeof data === "object" && data !== null && !globalThis.Array.isArray(data)
            ? (data as Readonly<Record<string, Schema.Json>>)
            : {},
      }),
  });

const jsonOfValues = (model: Model): string => {
  const patch = Result.getOrElse(
    patchOf(fieldsOf(model), model.values, model.initial, "create"),
    () => ({}),
  );
  return prettyJson(
    Mode.match(model.mode, {
      Create: () => patch,
      Edit: ({ data }) =>
        typeof data === "object" && data !== null && !globalThis.Array.isArray(data) ? data : patch,
    }),
  );
};

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    UpdatedId: ({ value }) => ({
      model: modifyFields(model, {
        idText: () => value,
        idCheck: () => IdCheck.Idle(),
        stage: (stage) => (stage._tag === "Checking" ? stage : Stage.Editing()),
      }),
    }),
    CommittedId: ({ value }) => {
      const id = value.trim();
      return String.isEmpty(id) || Option.isSome(idProblem(id)) || model.mode._tag !== "Create"
        ? { model: modifyFields(model, { idText: () => value }) }
        : {
            model: modifyFields(model, {
              idText: () => value,
              idCheck: () => IdCheck.Checking({ id }),
            }),
            commands: [CheckId({ id })],
          };
    },
    SucceededCheckId: ({ id, entity }) =>
      model.idCheck._tag === "Checking" && model.idCheck.id === id
        ? {
            model: modifyFields(model, { idCheck: () => IdCheck.Taken({ id, type: entity.type }) }),
          }
        : { model },
    FailedCheckId: ({ id, failure }) =>
      model.idCheck._tag === "Checking" && model.idCheck.id === id
        ? {
            model: modifyFields(model, {
              idCheck: () =>
                Option.contains(failure.code, "EntityNotFound")
                  ? IdCheck.Free({ id })
                  : Option.contains(failure.code, "EntityDeleted")
                    ? IdCheck.WasDeleted({ id })
                    : IdCheck.Failed({ id, failure }),
            }),
          }
        : { model },
    UpdatedField: ({ name, value }) => ({
      model: modifyFields(model, {
        values: (values) => ({ ...values, [name]: value }),
        stage: (stage) =>
          stage._tag === "Invalid"
            ? Stage.Invalid({
                ...stage,
                errors: Array.filter(stage.errors, (error) => error.field !== name),
              })
            : stage,
      }),
    }),
    ClickedEditJson: () => ({
      model: modifyFields(model, {
        editor: () => Editor.Json({ text: jsonOfValues(model) }),
        stage: () => Stage.Editing(),
      }),
    }),
    ClickedEditFields: () =>
      Editor.match<UpdateReturn>(model.editor, {
        Fields: () => ({ model }),
        Json: ({ text }) =>
          Result.match(parseJson(text), {
            onFailure: (error) => invalid(model, `Fix the JSON before switching back: ${error}`),
            onSuccess: (data) => ({
              model: modifyFields(model, {
                editor: () => Editor.Fields(),
                values: () => textsOf(fieldsOf(model), data),
                stage: () => Stage.Editing(),
              }),
            }),
          }),
      }),
    UpdatedJson: ({ value }) => ({
      model: modifyFields(model, {
        editor: (editor) => (editor._tag === "Json" ? Editor.Json({ text: value }) : editor),
      }),
    }),
    SubmittedForm: () =>
      model.stage._tag === "Checking"
        ? { model }
        : Editor.match<UpdateReturn>(model.editor, {
            Fields: () => submitFields(model),
            Json: ({ text }) => submitJson(model, text),
          }),
    SucceededCheckWrite: ({ check }) => {
      if (model.stage._tag !== "Checking") {
        return { model };
      }
      const id = Mode.match(model.mode, {
        Create: () => model.idText.trim(),
        Edit: ({ id: editId }) => editId,
      });
      if (model.mode._tag === "Create" && !check.created) {
        return {
          model: modifyFields(model, {
            idCheck: () => IdCheck.Taken({ id, type: model.type }),
            stage: () =>
              Stage.Invalid({ message: `${id} is taken. Choose another ID.`, errors: [] }),
          }),
        };
      }
      return {
        model: modifyFields(model, { stage: () => Stage.Editing() }),
        outMessage: OutMessage.PreparedWrite({
          write: PreparedWrite.Upsert({
            type: model.type,
            id,
            version: model.version,
            patch: submittedPatch(model),
            expectedRev: Mode.match(model.mode, { Create: () => 0, Edit: ({ rev }) => rev }),
            before: before(model),
            after: check.data,
            created: check.created,
          }),
        }),
      };
    },
    FailedCheckWrite: ({ failure }) =>
      model.stage._tag === "Checking"
        ? {
            model: modifyFields(model, {
              stage: () => Stage.Failed({ failure }),
              idCheck: (idCheck) =>
                Option.contains(failure.code, "EntityTypeMismatch") && model.mode._tag === "Create"
                  ? IdCheck.Taken({ id: model.idText.trim(), type: "another type" })
                  : idCheck,
            }),
          }
        : { model },
    ClickedCancel: () => ({ model, outMessage: OutMessage.Cancelled() }),
  });

// VIEW

const fieldId = (name: string) => `entity-field-${name}`;

const idHint = (check: IdCheck, h: HtmlBuilder<Message>): Html =>
  IdCheck.match(check, {
    Idle: () => h.empty,
    Checking: () => h.span([h.Class(inputDescriptionClass), h.Role("status")], ["Checking…"]),
    Free: ({ id }) =>
      h.span([h.Class(inputDescriptionClass), h.Role("status")], [`${id} is free.`]),
    WasDeleted: ({ id }) =>
      h.span(
        [h.Class(inputDescriptionClass), h.Role("status")],
        [`${id} was deleted; saving brings it back with its history.`],
      ),
    Taken: ({ id, type }) =>
      h.span(
        [h.Class("text-sm text-destructive"), h.Role("alert")],
        [`${id} is taken by a ${type}. Choose another ID.`],
      ),
    Failed: ({ failure }) =>
      h.span(
        [h.Class("text-sm text-destructive"), h.Role("alert")],
        [`Couldn't check the ID: ${failure.error}`],
      ),
  });

const idView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const id = model.idText.trim();
  const problem = String.isEmpty(id) ? Option.none() : idProblem(id);
  return h.div(
    [h.Class("flex max-w-sm flex-col gap-1.5")],
    [
      h.label([h.For("entity-id"), h.Class(inputLabelClass)], ["ID"]),
      h.input([
        h.Id("entity-id"),
        h.Value(model.idText),
        h.Placeholder("Generated when blank"),
        h.Spellcheck(false),
        h.OnInput((value) => Message.UpdatedId({ value })),
        h.OnChange((value) => Message.CommittedId({ value })),
        h.AriaInvalid(Option.isSome(problem) || model.idCheck._tag === "Taken"),
        h.AriaDescribedBy("entity-id-hint"),
        h.Class(cn(inputClass, "font-mono")),
      ]),
      h.div(
        [h.Id("entity-id-hint"), h.Class("min-h-5")],
        [
          Option.match(problem, {
            onNone: () => idHint(model.idCheck, h),
            onSome: (message) =>
              h.span([h.Class("text-sm text-destructive"), h.Role("alert")], [message]),
          }),
        ],
      ),
    ],
  );
};

const control = (
  field: FormField,
  value: string,
  isInvalid: boolean,
  h: HtmlBuilder<Message>,
): Html => {
  const common = [
    h.Id(fieldId(field.name)),
    h.Value(value),
    h.AriaInvalid(isInvalid),
    h.AriaDescribedBy(`${fieldId(field.name)}-hint`),
  ];
  const onInput = h.OnInput((next) => Message.UpdatedField({ name: field.name, value: next }));
  const onChange = h.OnChange((next) => Message.UpdatedField({ name: field.name, value: next }));
  const options = (choices: ReadonlyArray<readonly [string, string]>) =>
    Array.map(choices, ([optionValue, label]) =>
      h.keyed("option")(
        optionValue === "" ? "(unset)" : optionValue,
        [h.Value(optionValue), h.Selected(optionValue === value)],
        [label],
      ),
    );
  return InputKind.match(field.input, {
    Text: ({ format }) =>
      h.input([
        ...common,
        h.Type(format === "plain" ? "text" : format),
        onInput,
        h.Class(inputClass),
      ]),
    Number: ({ isInteger }) =>
      h.input([
        ...common,
        h.Type("number"),
        h.Step(isInteger ? "1" : "any"),
        onInput,
        h.Class(inputClass),
      ]),
    Boolean: () =>
      h.select(
        [...common, onChange, h.Class(cn(selectClass, "w-full"))],
        options([
          ["", field.isRequired ? "Choose…" : "Unset"],
          ["true", "Yes"],
          ["false", "No"],
        ]),
      ),
    Choice: ({ values }) =>
      h.select(
        [...common, onChange, h.Class(cn(selectClass, "w-full"))],
        options([
          ["", field.isRequired ? "Choose…" : "Unset"],
          ...Array.map(values, (choice) => [choice, choice] as const),
          ...(value === "" || values.includes(value) ? [] : [[value, value] as const]),
        ]),
      ),
    Date: () => h.input([...common, h.Type("date"), onInput, h.Class(inputClass)]),
    DateTime: () =>
      h.input([...common, h.Type("datetime-local"), h.Step("1"), onInput, h.Class(inputClass)]),
    Link: ({ to }) =>
      h.input([
        ...common,
        h.Placeholder(`ID of a ${to}`),
        h.Spellcheck(false),
        onInput,
        h.Class(cn(inputClass, "font-mono")),
      ]),
    Json: () =>
      h.textarea([
        ...common,
        h.Rows(3),
        h.Spellcheck(false),
        onInput,
        h.Class(cn(textareaClass, "font-mono text-xs")),
      ]),
  });
};

const hintOf = (field: FormField): string =>
  [
    InputKind.match(field.input, {
      Text: ({ format }) => (format === "plain" ? "Text" : format === "email" ? "Email" : "URL"),
      Number: ({ isInteger }) => (isInteger ? "Whole number" : "Number"),
      Boolean: () => "Yes or no",
      Choice: () => "One of the choices",
      Date: () => "Date",
      DateTime: () => "Date and time, UTC",
      Link: ({ to }) => `ID of a ${to}`,
      Json: () => "JSON",
    }),
    field.isRequired ? "required" : "optional; leave empty to clear",
  ].join(", ");

const fieldView = (
  field: FormField,
  model: Model,
  errors: ReadonlyArray<FieldError>,
  h: HtmlBuilder<Message>,
): Html => {
  const maybeError = Array.findFirst(errors, (error) => error.field === field.name);
  return h.keyed("div")(
    field.name,
    [
      h.Class(
        cn(
          "flex min-w-0 flex-col gap-1.5",
          field.input._tag === "Json" ? "sm:col-span-2" : undefined,
        ),
      ),
    ],
    [
      h.label(
        [h.For(fieldId(field.name)), h.Class(inputLabelClass)],
        [
          field.label,
          field.label === field.name
            ? h.empty
            : h.span([h.Class("font-mono text-xs text-muted-foreground")], [field.name]),
        ],
      ),
      control(field, model.values[field.name] ?? "", Option.isSome(maybeError), h),
      h.span(
        [h.Id(`${fieldId(field.name)}-hint`), h.Class("text-xs")],
        [
          Option.match(maybeError, {
            onNone: () => h.span([h.Class("text-muted-foreground")], [hintOf(field)]),
            onSome: (error) =>
              h.span([h.Class("text-destructive"), h.Role("alert")], [error.message]),
          }),
        ],
      ),
    ],
  );
};

const stageView = (stage: Stage, h: HtmlBuilder<Message>): Html =>
  Stage.match(stage, {
    Editing: () => h.empty,
    Invalid: ({ message }) => errorAlert(message, h),
    Checking: () => statusText("Checking the write…", h),
    Failed: ({ failure }) => failureAlert(failure, h),
  });

const submitLabel = (model: Model) =>
  model.stage._tag === "Checking"
    ? "Checking…"
    : model.mode._tag === "Create"
      ? "Review new entity"
      : "Review changes";

export const view = Submodel.defineView<Model, Message>((model, h): Html => {
  const errors = model.stage._tag === "Invalid" ? model.stage.errors : [];
  return h.form(
    [
      h.OnSubmit(Message.SubmittedForm()),
      h.Class("space-y-4"),
      h.AriaLabel(model.mode._tag === "Create" ? `New ${model.type}` : `Edit ${model.type}`),
      h.Novalidate(true),
    ],
    [
      model.mode._tag === "Create" ? idView(model, h) : h.empty,
      Editor.match(model.editor, {
        Fields: () =>
          Array.match(fieldsOf(model), {
            onEmpty: () => statusText(`v${model.version} has no fields.`, h),
            onNonEmpty: (fields) =>
              h.div(
                [h.Class("grid gap-4 sm:grid-cols-2")],
                Array.map(fields, (field) => fieldView(field, model, errors, h)),
              ),
          }),
        Json: ({ text }) =>
          textarea(
            {
              id: "entity-json",
              label: `Data as v${model.version} (JSON)`,
              description:
                model.mode._tag === "Create"
                  ? "The whole document."
                  : "The whole document; saving replaces it.",
              value: text,
              rows: 12,
              onInput: (value) => Message.UpdatedJson({ value }),
              className: "max-h-[32rem] font-mono text-xs",
            },
            h,
          ),
      }),
      stageView(model.stage, h),
      h.div(
        [h.Class("flex flex-wrap items-center gap-2")],
        [
          button(
            { type: "submit", isDisabled: model.stage._tag === "Checking" },
            submitLabel(model),
            h,
          ),
          button(
            { type: "button", variant: "ghost", onClick: Message.ClickedCancel() },
            "Cancel",
            h,
          ),
          h.span([h.Class("flex-1")]),
          Editor.match(model.editor, {
            Fields: () =>
              button(
                {
                  type: "button",
                  variant: "outline",
                  size: "sm",
                  onClick: Message.ClickedEditJson(),
                },
                "Edit as JSON",
                h,
              ),
            Json: () =>
              button(
                {
                  type: "button",
                  variant: "outline",
                  size: "sm",
                  onClick: Message.ClickedEditFields(),
                },
                "Edit fields",
                h,
              ),
          }),
        ],
      ),
    ],
  );
});

/** Schema decode for a version's opaque JSON schema. */
export const decodeSchema = Schema.decodeUnknownOption(EntitySchema);
