import * as Array from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as String from "effect/String";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";
import type * as Update from "foldkit/update";
import { Detail } from "@/components/confirm";
import { selectClass } from "@/components/select";
import { button } from "@/components/ui/button";
import { input, inputClass, inputDescriptionClass, inputLabelClass } from "@/components/ui/input";
import { textarea } from "@/components/ui/textarea";
import { parseJson } from "@/domain/json";
import {
  type FieldDraft,
  FieldKind,
  type TypeDraft,
  blankField,
  canBeTitle,
  decodeSchema,
  describeField,
  draftOf,
  formKinds,
  kindLabels,
  newTypeDraft,
  nextVersionOf,
  schemaOf,
} from "@/domain/typeDraft";
import { TypeDraft as TypeDraftSchema } from "@/domain/typeDraft";
import { cn } from "@/lib/utils";
import { Lens } from "../../../lens/model.ts";
import { EntitySchema, TYPE_NAME_PATTERN } from "../../../schema/model.ts";

// The type form: field rows with a kind each, a "Points to" type for links,
// and the title picked from the rows. It creates a type, or edits the latest
// version of one in place, generating the next version's lens. Raw JSON is
// there for a new type's schema; editing by hand-written lens is the New
// version page's job.

// MODEL

export const Mode = defineTaggedUnion({
  Create: {},
  Edit: { type: Schema.String, version: Schema.Int, schema: EntitySchema },
});
export type Mode = typeof Mode.Type;

export const Editor = defineTaggedUnion({
  Fields: {},
  Json: { text: Schema.String },
});
export type Editor = typeof Editor.Type;

export const Model = Schema.Struct({
  mode: Mode,
  draft: TypeDraftSchema,
  editor: Editor,
  /** Types a link can point to (the type itself included when it exists). */
  targets: Schema.Array(Schema.String),
  problems: Schema.Array(Schema.String),
});
export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  UpdatedName: { value: Schema.String },
  UpdatedDescription: { value: Schema.String },
  SelectedTitle: { value: Schema.String },
  ClickedAddField: {},
  ClickedRemoveField: { key: Schema.Int },
  UpdatedFieldName: { key: Schema.Int, value: Schema.String },
  SelectedFieldKind: { key: Schema.Int, value: Schema.String },
  SelectedFieldTarget: { key: Schema.Int, value: Schema.String },
  UpdatedFieldValues: { key: Schema.Int, value: Schema.String },
  ToggledFieldRequired: { key: Schema.Int, isRequired: Schema.Boolean },
  UpdatedFieldDescription: { key: Schema.Int, value: Schema.String },
  ClickedEditJson: {},
  ClickedEditFields: {},
  UpdatedJson: { value: Schema.String },
  SubmittedForm: {},
  ClickedCancel: {},
});
export type Message = typeof Message.Type;

export const OutMessage = defineMessageUnion({
  SubmittedNewType: {
    name: Schema.String,
    description: Schema.String,
    schema: EntitySchema,
    details: Schema.Array(Detail),
  },
  SubmittedVersion: {
    schema: EntitySchema,
    lens: Lens,
    details: Schema.Array(Detail),
    renamed: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String })),
    removed: Schema.Array(Schema.String),
  },
  Cancelled: {},
});
export type OutMessage = typeof OutMessage.Type;

// INIT

export const initCreate = (targets: ReadonlyArray<string>): Model =>
  Model.make({
    mode: Mode.Create(),
    draft: newTypeDraft,
    editor: Editor.Fields(),
    targets,
    problems: [],
  });

export const initEdit = (
  type: string,
  version: number,
  schema: EntitySchema,
  targets: ReadonlyArray<string>,
): Model =>
  Model.make({
    mode: Mode.Edit({ type, version, schema }),
    draft: draftOf(type, schema),
    editor: Editor.Fields(),
    targets: Array.dedupe([type, ...targets]),
    problems: [],
  });

// UPDATE

/** The types a link can point to, as they're known now. */
export const withTargets = (
  model: Model,
  targets: ReadonlyArray<string>,
): Update.Return<Model, Message> => ({
  model: modifyFields(model, {
    targets: () =>
      Mode.match(model.mode, {
        Create: () => targets,
        Edit: ({ type }) => Array.dedupe([type, ...targets]),
      }),
  }),
});

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>;

const withDraft = (model: Model, change: (draft: TypeDraft) => TypeDraft): UpdateReturn => ({
  model: modifyFields(model, { draft: change, problems: () => [] }),
});

const withField = (
  model: Model,
  key: number,
  change: (field: FieldDraft) => FieldDraft,
): UpdateReturn =>
  withDraft(model, (draft) =>
    modifyFields(draft, {
      fields: (fields) => Array.map(fields, (field) => (field.key === key ? change(field) : field)),
    }),
  );

const typeNamePattern = new RegExp(TYPE_NAME_PATTERN);

const newTypeDetails = (schema: EntitySchema): ReadonlyArray<Detail> =>
  Array.map(Object.entries(schema.fields), ([name, type]) =>
    Detail.make({
      label: name,
      before: Option.none(),
      after: Option.some(`${describeField(type)}${schema.title === name ? ", title" : ""}`),
    }),
  );

const submitCreate = (model: Model, schema: EntitySchema): UpdateReturn => {
  const name = model.draft.name.trim();
  const problems = [
    ...(String.isEmpty(name)
      ? ["Give the type a name"]
      : typeNamePattern.test(name)
        ? []
        : ["Type names start with a letter and use letters, digits, '_' or '-' (up to 64)"]),
    ...(model.targets.includes(name) ? [`There's already a type named ${name}`] : []),
  ];
  return Array.isReadonlyArrayNonEmpty(problems)
    ? { model: modifyFields(model, { problems: () => problems }) }
    : {
        model,
        outMessage: OutMessage.SubmittedNewType({
          name,
          description: model.draft.description.trim(),
          schema,
          details: newTypeDetails(schema),
        }),
      };
};

const submitFields = (model: Model): UpdateReturn =>
  Mode.match<UpdateReturn>(model.mode, {
    Create: () =>
      Result.match(schemaOf(model.draft), {
        onFailure: (problems) => ({ model: modifyFields(model, { problems: () => problems }) }),
        onSuccess: (schema) => submitCreate(model, schema),
      }),
    Edit: ({ schema: current }) =>
      Result.match(nextVersionOf(current, model.draft), {
        onFailure: (problems) => ({ model: modifyFields(model, { problems: () => problems }) }),
        onSuccess: (next) =>
          next.changed
            ? {
                model,
                outMessage: OutMessage.SubmittedVersion({
                  schema: next.schema,
                  lens: next.lens,
                  details: [
                    ...(current.title === next.schema.title
                      ? []
                      : [
                          Detail.make({
                            label: "(title)",
                            before: Option.fromNullishOr(current.title),
                            after: Option.fromNullishOr(next.schema.title),
                          }),
                        ]),
                    ...(current.description === next.schema.description
                      ? []
                      : [
                          Detail.make({
                            label: "(description)",
                            before: Option.fromNullishOr(current.description),
                            after: Option.fromNullishOr(next.schema.description),
                          }),
                        ]),
                    ...Array.map(next.changes, (change) => {
                      switch (change.kind) {
                        case "added":
                          return Detail.make({
                            label: change.name,
                            before: Option.none(),
                            after: Option.some(describeField(change.type)),
                          });
                        case "removed":
                          return Detail.make({
                            label: change.name,
                            before: Option.some(describeField(change.type)),
                            after: Option.none(),
                          });
                        case "renamed":
                          return Detail.make({
                            label: `${change.from} → ${change.to}`,
                            before: Option.some(`${change.from}: ${describeField(change.before)}`),
                            after: Option.some(`${change.to}: ${describeField(change.after)}`),
                          });
                        case "changed":
                          return Detail.make({
                            label: change.name,
                            before: Option.some(JSON.stringify(change.before)),
                            after: Option.some(JSON.stringify(change.after)),
                          });
                      }
                    }),
                  ],
                  renamed: Array.filterMap(next.changes, (change) =>
                    change.kind === "renamed"
                      ? Result.succeed({ from: change.from, to: change.to })
                      : Result.failVoid,
                  ),
                  removed: Array.filterMap(next.changes, (change) =>
                    change.kind === "removed" ? Result.succeed(change.name) : Result.failVoid,
                  ),
                }),
              }
            : { model: modifyFields(model, { problems: () => ["Nothing changed."] }) },
      }),
  });

const submitJson = (model: Model, text: string): UpdateReturn =>
  Result.match(parseJson(text), {
    onFailure: (error) => ({
      model: modifyFields(model, { problems: () => [`The schema isn't valid JSON: ${error}`] }),
    }),
    onSuccess: (json) =>
      Option.match(decodeSchema(json), {
        onNone: () => ({
          model: modifyFields(model, {
            problems: () => [
              "The schema doesn't fit the schema language: the root needs `fields`, each with a `type`",
            ],
          }),
        }),
        onSome: (schema) => submitCreate(model, schema),
      }),
  });

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    UpdatedName: ({ value }) =>
      withDraft(model, (draft) => modifyFields(draft, { name: () => value })),
    UpdatedDescription: ({ value }) =>
      withDraft(model, (draft) => modifyFields(draft, { description: () => value })),
    SelectedTitle: ({ value }) =>
      withDraft(model, (draft) =>
        modifyFields(draft, {
          maybeTitleKey: () => (String.isEmpty(value) ? Option.none() : Option.some(Number(value))),
        }),
      ),
    ClickedAddField: () =>
      withDraft(model, (draft) =>
        modifyFields(draft, {
          fields: (fields) => Array.append(fields, blankField(draft.nextKey)),
          nextKey: (key) => key + 1,
        }),
      ),
    ClickedRemoveField: ({ key }) =>
      withDraft(model, (draft) =>
        modifyFields(draft, {
          fields: (fields) => Array.filter(fields, (field) => field.key !== key),
          maybeTitleKey: (title) => Option.filter(title, (titleKey) => titleKey !== key),
        }),
      ),
    UpdatedFieldName: ({ key, value }) =>
      withField(model, key, (field) => modifyFields(field, { name: () => value })),
    SelectedFieldKind: ({ key, value }) =>
      Option.match(Schema.decodeUnknownOption(FieldKind)(value), {
        onNone: () => ({ model }),
        onSome: (kind) =>
          withField(model, key, (field) => modifyFields(field, { kind: () => kind })),
      }),
    SelectedFieldTarget: ({ key, value }) =>
      withField(model, key, (field) => modifyFields(field, { to: () => value })),
    UpdatedFieldValues: ({ key, value }) =>
      withField(model, key, (field) => modifyFields(field, { values: () => value })),
    ToggledFieldRequired: ({ key, isRequired }) =>
      withField(model, key, (field) => modifyFields(field, { isRequired: () => isRequired })),
    UpdatedFieldDescription: ({ key, value }) =>
      withField(model, key, (field) => modifyFields(field, { description: () => value })),
    ClickedEditJson: () =>
      Result.match(schemaOf(model.draft), {
        onFailure: (problems) => ({ model: modifyFields(model, { problems: () => problems }) }),
        onSuccess: (schema) => ({
          model: modifyFields(model, {
            editor: () => Editor.Json({ text: JSON.stringify(schema, null, 2) }),
            problems: () => [],
          }),
        }),
      }),
    ClickedEditFields: () =>
      Editor.match<UpdateReturn>(model.editor, {
        Fields: () => ({ model }),
        Json: ({ text }) =>
          Option.match(
            Result.match(parseJson(text), {
              onFailure: () => Option.none(),
              onSuccess: decodeSchema,
            }),
            {
              onNone: () => ({
                model: modifyFields(model, {
                  problems: () => ["Fix the schema JSON before switching back to the fields"],
                }),
              }),
              onSome: (schema) => ({
                model: modifyFields(model, {
                  editor: () => Editor.Fields(),
                  draft: (draft) =>
                    modifyFields(draftOf(draft.name, schema), {
                      name: () => draft.name,
                      fields: (fields) =>
                        Array.map(fields, (field) =>
                          modifyFields(field, {
                            maybeOrigin: () => Option.none(),
                          }),
                        ),
                    }),
                  problems: () => [],
                }),
              }),
            },
          ),
      }),
    UpdatedJson: ({ value }) => ({
      model: modifyFields(model, {
        editor: (editor) => (editor._tag === "Json" ? Editor.Json({ text: value }) : editor),
        problems: () => [],
      }),
    }),
    SubmittedForm: () =>
      Editor.match<UpdateReturn>(model.editor, {
        Fields: () => submitFields(model),
        Json: ({ text }) => submitJson(model, text),
      }),
    ClickedCancel: () => ({ model, outMessage: OutMessage.Cancelled() }),
  });

// VIEW

const rowName = (field: FieldDraft) =>
  String.isEmpty(field.name.trim()) ? "new field" : field.name.trim();

const kindSelect = (field: FieldDraft, h: HtmlBuilder<Message>): Html => {
  const kinds = field.kind === "other" ? [...formKinds, "other" as const] : formKinds;
  return h.select(
    [
      h.AriaLabel(`Kind of ${rowName(field)}`),
      h.Value(field.kind),
      h.OnChange((value) => Message.SelectedFieldKind({ key: field.key, value })),
      h.Class(cn(selectClass, "w-full")),
    ],
    Array.map(kinds, (kind) =>
      h.keyed("option")(kind, [h.Value(kind), h.Selected(kind === field.kind)], [kindLabels[kind]]),
    ),
  );
};

const kindSettings = (model: Model, field: FieldDraft, h: HtmlBuilder<Message>): Html =>
  field.kind === "link"
    ? h.select(
        [
          h.AriaLabel(`Points to (${rowName(field)})`),
          h.Value(field.to),
          h.OnChange((value) => Message.SelectedFieldTarget({ key: field.key, value })),
          h.Class(cn(selectClass, "w-full")),
        ],
        Array.map(
          [
            "",
            ...model.targets,
            ...(String.isEmpty(field.to) || model.targets.includes(field.to) ? [] : [field.to]),
            ...Mode.match(model.mode, {
              Create: () => {
                const name = model.draft.name.trim();
                return String.isEmpty(name) || model.targets.includes(name) ? [] : [name];
              },
              Edit: () => [],
            }),
          ],
          (target) =>
            h.keyed("option")(
              target === "" ? "(choose)" : target,
              [h.Value(target), h.Selected(target === field.to)],
              [target === "" ? "Points to…" : target],
            ),
        ),
      )
    : field.kind === "choice"
      ? h.input([
          h.AriaLabel(`Choices for ${rowName(field)}`),
          h.Value(field.values),
          h.Placeholder("admin, member"),
          h.OnInput((value) => Message.UpdatedFieldValues({ key: field.key, value })),
          h.Class(inputClass),
        ])
      : h.span([h.Class("flex h-8 items-center px-1 text-xs text-muted-foreground")], ["—"]);

const fieldRow = (model: Model, field: FieldDraft, h: HtmlBuilder<Message>): Html =>
  h.keyed("li")(
    `${field.key}`,
    [
      h.Class(
        "grid gap-2 rounded-lg border border-border p-2 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_auto_auto] sm:items-center sm:border-0 sm:p-0",
      ),
      h.Role("group"),
      h.AriaLabel(`Field ${rowName(field)}`),
    ],
    [
      h.input([
        h.AriaLabel(`Name of ${rowName(field)}`),
        h.Value(field.name),
        h.Placeholder("start_date"),
        h.Spellcheck(false),
        h.OnInput((value) => Message.UpdatedFieldName({ key: field.key, value })),
        h.Class(cn(inputClass, "font-mono")),
      ]),
      kindSelect(field, h),
      kindSettings(model, field, h),
      h.label(
        [h.Class("flex items-center gap-1.5 text-sm")],
        [
          h.input([
            h.Type("checkbox"),
            h.Checked(field.isRequired),
            h.OnClick(
              Message.ToggledFieldRequired({ key: field.key, isRequired: !field.isRequired }),
            ),
            h.AriaLabel(`${rowName(field)} is required`),
          ]),
          "Required",
        ],
      ),
      button(
        {
          type: "button",
          variant: "ghost",
          size: "sm",
          onClick: Message.ClickedRemoveField({ key: field.key }),
          attributes: [h.AriaLabel(`Remove ${rowName(field)}`)],
        },
        "Remove",
        h,
      ),
      h.input([
        h.AriaLabel(`Description of ${rowName(field)}`),
        h.Value(field.description),
        h.Placeholder("Description (optional)"),
        h.OnInput((value) => Message.UpdatedFieldDescription({ key: field.key, value })),
        h.Class(cn(inputClass, "sm:col-span-5 text-xs md:text-xs")),
      ]),
    ],
  );

const titleSelect = (model: Model, h: HtmlBuilder<Message>): Html => {
  const candidates = Array.filter(model.draft.fields, canBeTitle);
  const selected = Option.match(model.draft.maybeTitleKey, {
    onNone: () => "",
    onSome: (key) => `${key}`,
  });
  return h.div(
    [h.Class("flex flex-col gap-1.5")],
    [
      h.label([h.For("type-title"), h.Class(inputLabelClass)], ["Title field"]),
      h.select(
        [
          h.Id("type-title"),
          h.Value(selected),
          h.OnChange((value) => Message.SelectedTitle({ value })),
          h.Class(cn(selectClass, "w-full")),
          h.AriaDescribedBy("type-title-hint"),
        ],
        [
          h.keyed("option")(
            "(none)",
            [h.Value(""), h.Selected(selected === "")],
            ["None (show IDs)"],
          ),
          ...Array.map(candidates, (field) =>
            h.keyed("option")(
              `${field.key}`,
              [h.Value(`${field.key}`), h.Selected(`${field.key}` === selected)],
              [rowName(field)],
            ),
          ),
        ],
      ),
      h.span(
        [h.Id("type-title-hint"), h.Class(inputDescriptionClass)],
        ["The text field that names each entity. It stays the title when renamed."],
      ),
    ],
  );
};

const problemsView = (problems: ReadonlyArray<string>, h: HtmlBuilder<Message>): Html =>
  Array.match(problems, {
    onEmpty: () => h.empty,
    onNonEmpty: (nonEmpty) =>
      h.div(
        [
          h.Class(
            "rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive",
          ),
          h.Role("alert"),
        ],
        [
          h.p([h.Class("font-medium")], ["Fix these first:"]),
          h.ul(
            [h.Class("mt-1 list-disc space-y-0.5 pl-5")],
            Array.map(nonEmpty, (problem) => h.keyed("li")(problem, [], [problem])),
          ),
        ],
      ),
  });

const automationsHint = (model: Model, h: HtmlBuilder<Message>): Html => {
  const name = model.draft.name.trim();
  return model.mode._tag === "Create" &&
    String.isNonEmpty(name) &&
    !/^[a-z][a-z0-9_]{0,39}$/.test(name)
    ? h.p(
        [h.Class("text-xs text-amber-700 dark:text-amber-400")],
        [`automations only reads types with snake_case names, so it won't see ${name}.`],
      )
    : h.empty;
};

const fieldsEditor = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("space-y-3")],
    [
      h.div(
        [
          h.Class(
            "hidden gap-2 px-0.5 text-xs font-medium text-muted-foreground sm:grid sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_auto_auto]",
          ),
          h.AriaHidden(true),
        ],
        [
          h.span([], ["Field"]),
          h.span([], ["Kind"]),
          h.span([], ["Points to / choices"]),
          h.span([h.Class("w-20")], ["Required"]),
          h.span([h.Class("w-16")]),
        ],
      ),
      h.ul(
        [h.Class("space-y-3"), h.AriaLabel("Fields")],
        Array.map(model.draft.fields, (field) => fieldRow(model, field, h)),
      ),
      button(
        { type: "button", variant: "outline", size: "sm", onClick: Message.ClickedAddField() },
        "Add field",
        h,
      ),
      titleSelect(model, h),
    ],
  );

export const view = Submodel.defineView<Model, Message>((model, h): Html =>
  h.form(
    [
      h.OnSubmit(Message.SubmittedForm()),
      h.Class("space-y-4"),
      h.AriaLabel(Mode.match(model.mode, { Create: () => "New type", Edit: () => "Edit fields" })),
      h.Novalidate(true),
    ],
    [
      Mode.match(model.mode, {
        Create: () =>
          h.div(
            [h.Class("grid gap-4 sm:grid-cols-[minmax(0,14rem)_1fr]")],
            [
              input(
                {
                  id: "type-name",
                  label: "Name",
                  value: model.draft.name,
                  placeholder: "person",
                  description: "Letters, digits, '_' or '-'.",
                  onInput: (value) => Message.UpdatedName({ value }),
                  className: "font-mono",
                },
                h,
              ),
              input(
                {
                  id: "type-description",
                  label: "Description",
                  value: model.draft.description,
                  placeholder: "What is this entity?",
                  onInput: (value) => Message.UpdatedDescription({ value }),
                },
                h,
              ),
            ],
          ),
        Edit: ({ version }) =>
          h.p(
            [h.Class("text-sm text-muted-foreground")],
            [
              `Saving adds v${version + 1} with a lens generated from your changes: renames, added optional fields, and removed fields. Changing a field's kind needs a hand-written lens on the New version page.`,
            ],
          ),
      }),
      automationsHint(model, h),
      Editor.match(model.editor, {
        Fields: () => fieldsEditor(model, h),
        Json: ({ text }) =>
          textarea(
            {
              id: "type-schema-json",
              label: "Schema (JSON)",
              description:
                "The root is an object with `fields`. See docs/data-model.md for field types.",
              value: text,
              rows: 14,
              onInput: (value) => Message.UpdatedJson({ value }),
              className: "max-h-[32rem] font-mono text-xs",
            },
            h,
          ),
      }),
      problemsView(model.problems, h),
      h.div(
        [h.Class("flex flex-wrap items-center gap-2")],
        [
          button(
            { type: "submit" },
            Mode.match(model.mode, {
              Create: () => "Review new type",
              Edit: () => "Review changes",
            }),
            h,
          ),
          Mode.match(model.mode, {
            Create: () => h.empty,
            Edit: () =>
              button(
                { type: "button", variant: "ghost", onClick: Message.ClickedCancel() },
                "Cancel",
                h,
              ),
          }),
          h.span([h.Class("flex-1")]),
          Mode.match(model.mode, {
            Edit: () => h.empty,
            Create: () =>
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
          }),
        ],
      ),
    ],
  ),
);
