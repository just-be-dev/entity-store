import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as String from "effect/String";
import * as Result from "effect/Result";
import { Command, Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { pushUrl } from "foldkit/navigation";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";
import type * as Update from "foldkit/update";
import { apiUrl, getJson, postJson } from "@/api";
import { errorAlert, failureAlert, issueList, successAlert } from "@/components/feedback";
import { pageHeader, section, statusText } from "@/components/layout";
import { badge } from "@/components/ui/badge";
import { button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { input } from "@/components/ui/input";
import { textarea } from "@/components/ui/textarea";
import {
  ApiFailure,
  Issue,
  SchemaCheck as SchemaCheckResponse,
  TypeInfo,
  TypeList,
  TypeSummary,
} from "@/domain/entityStore";
import { parseJson } from "@/domain/json";
import { formatTime } from "@/lib/format";
import { AppRoute, href } from "@/route";

export const EXAMPLE_SCHEMA = `{
  "description": "A person",
  "fields": {
    "name": { "type": "string", "minLength": 1 },
    "email": { "type": "string", "format": "email" },
    "age": { "type": "number", "integer": true, "min": 0, "optional": true },
    "tags": { "type": "array", "items": { "type": "string" } }
  }
}`;

// MODEL

export const Types = defineTaggedUnion({
  Loading: {},
  Failed: { failure: ApiFailure },
  Loaded: { items: Schema.Array(TypeSummary) },
});
export type Types = typeof Types.Type;

export const SchemaCheck = defineTaggedUnion({
  Idle: {},
  Checking: {},
  Invalid: { message: Schema.String },
  Checked: { ok: Schema.Boolean, issues: Schema.Array(Issue) },
  Failed: { failure: ApiFailure },
});
export type SchemaCheck = typeof SchemaCheck.Type;

export const Submission = defineTaggedUnion({
  Idle: {},
  Submitting: {},
  Invalid: { message: Schema.String },
  Failed: { failure: ApiFailure },
});
export type Submission = typeof Submission.Type;

export const Model = Schema.Struct({
  types: Types,
  name: Schema.String,
  description: Schema.String,
  schemaText: Schema.String,
  schemaCheck: SchemaCheck,
  submission: Submission,
});
export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  SucceededFetchTypes: { items: Schema.Array(TypeSummary) },
  FailedFetchTypes: { failure: ApiFailure },
  UpdatedName: { value: Schema.String },
  UpdatedDescription: { value: Schema.String },
  UpdatedSchemaText: { value: Schema.String },
  ClickedCheckSchema: {},
  SucceededCheckSchema: { ok: Schema.Boolean, issues: Schema.Array(Issue) },
  FailedCheckSchema: { failure: ApiFailure },
  SubmittedNewType: {},
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

export const CheckSchema = Command.define("CheckSchema", {
  args: { schema: Schema.Json },
  messages: [Message.SucceededCheckSchema, Message.FailedCheckSchema],
  execute: ({ schema }) =>
    postJson(apiUrl("schema/check"), { schema }, SchemaCheckResponse).pipe(
      Effect.map(({ ok, issues }) => Message.SucceededCheckSchema({ ok, issues })),
      Effect.catch((failure) => Effect.succeed(Message.FailedCheckSchema({ failure }))),
    ),
});

export const CreateType = Command.define("CreateType", {
  args: { name: Schema.String, description: Schema.String, schema: Schema.Json },
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
    name: "",
    description: "",
    schemaText: EXAMPLE_SCHEMA,
    schemaCheck: SchemaCheck.Idle(),
    submission: Submission.Idle(),
  }),
  commands: [FetchTypes()],
});

// UPDATE

const isSubmitting = (submission: Submission) => submission._tag === "Submitting";

export const update = (model: Model, message: Message) =>
  Message.match<Update.ReturnWithOutMessage<Model, Message, OutMessage>>(message, {
    SucceededFetchTypes: ({ items }) => ({
      model: modifyFields(model, { types: () => Types.Loaded({ items }) }),
    }),
    FailedFetchTypes: ({ failure }) => ({
      model: modifyFields(model, { types: () => Types.Failed({ failure }) }),
    }),
    UpdatedName: ({ value }) => ({ model: modifyFields(model, { name: () => value }) }),
    UpdatedDescription: ({ value }) => ({
      model: modifyFields(model, { description: () => value }),
    }),
    UpdatedSchemaText: ({ value }) => ({
      model: modifyFields(model, {
        schemaText: () => value,
        schemaCheck: () => SchemaCheck.Idle(),
      }),
    }),
    ClickedCheckSchema: () =>
      Result.match(parseJson(model.schemaText), {
        onFailure: (message) => ({
          model: modifyFields(model, {
            schemaCheck: () =>
              SchemaCheck.Invalid({ message: `Schema isn't valid JSON: ${message}` }),
          }),
        }),
        onSuccess: (schema) => ({
          model: modifyFields(model, { schemaCheck: () => SchemaCheck.Checking() }),
          commands: [CheckSchema({ schema })],
        }),
      }),
    SucceededCheckSchema: ({ ok, issues }) => ({
      model: modifyFields(model, { schemaCheck: () => SchemaCheck.Checked({ ok, issues }) }),
    }),
    FailedCheckSchema: ({ failure }) => ({
      model: modifyFields(model, { schemaCheck: () => SchemaCheck.Failed({ failure }) }),
    }),
    SubmittedNewType: () => {
      if (isSubmitting(model.submission)) {
        return { model };
      }
      const name = model.name.trim();
      if (String.isEmpty(name)) {
        return {
          model: modifyFields(model, {
            submission: () => Submission.Invalid({ message: "Give the type a name." }),
          }),
        };
      }
      return Result.match(parseJson(model.schemaText), {
        onFailure: (message) => ({
          model: modifyFields(model, {
            submission: () =>
              Submission.Invalid({ message: `Schema isn't valid JSON: ${message}` }),
          }),
        }),
        onSuccess: (schema) => ({
          model: modifyFields(model, { submission: () => Submission.Submitting() }),
          commands: [CreateType({ name, description: model.description.trim(), schema })],
        }),
      });
    },
    SucceededCreateType: ({ name }) => ({
      model,
      commands: [NavigateToType({ name })],
      outMessage: OutMessage.CreatedType({ name }),
    }),
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
              Empty.description({}, ["Define a schema below to create the first one."], h),
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

const schemaCheckView = (check: SchemaCheck, h: HtmlBuilder<Message>): Html =>
  SchemaCheck.match(check, {
    Idle: () => h.empty,
    Checking: () => statusText("Checking schema…", h),
    Invalid: ({ message }) => errorAlert(message, h),
    Checked: ({ ok, issues }) =>
      ok
        ? successAlert(["Schema looks good."], h)
        : h.div(
            [
              h.Class(
                "rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive",
              ),
              h.Role("alert"),
            ],
            [h.span([h.Class("font-medium")], ["The schema has problems:"]), issueList(issues, h)],
          ),
    Failed: ({ failure }) => failureAlert(failure, h),
  });

const submissionView = (submission: Submission, h: HtmlBuilder<Message>): Html =>
  Submission.match(submission, {
    Idle: () => h.empty,
    Submitting: () => statusText("Creating type…", h),
    Invalid: ({ message }) => errorAlert(message, h),
    Failed: ({ failure }) => failureAlert(failure, h),
  });

const newTypeForm = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.form(
    [h.OnSubmit(Message.SubmittedNewType()), h.Class("space-y-4"), h.AriaLabel("New type")],
    [
      h.div(
        [h.Class("grid gap-4 sm:grid-cols-[minmax(0,14rem)_1fr]")],
        [
          input(
            {
              id: "new-type-name",
              label: "Name",
              value: model.name,
              placeholder: "person",
              description: "Letters, digits, '_' or '-'.",
              onInput: (value) => Message.UpdatedName({ value }),
              className: "font-mono",
            },
            h,
          ),
          input(
            {
              id: "new-type-description",
              label: "Description",
              value: model.description,
              placeholder: "What is this entity?",
              onInput: (value) => Message.UpdatedDescription({ value }),
            },
            h,
          ),
        ],
      ),
      textarea(
        {
          id: "new-type-schema",
          label: "Schema (JSON)",
          description:
            "The root is an object with `fields`. See docs/data-model.md for field types.",
          value: model.schemaText,
          rows: 14,
          onInput: (value) => Message.UpdatedSchemaText({ value }),
          className: "max-h-[32rem] font-mono text-xs",
        },
        h,
      ),
      schemaCheckView(model.schemaCheck, h),
      submissionView(model.submission, h),
      h.div(
        [h.Class("flex flex-wrap gap-2")],
        [
          button(
            { type: "submit", isDisabled: isSubmitting(model.submission) },
            isSubmitting(model.submission) ? "Creating…" : "Create type",
            h,
          ),
          button(
            {
              type: "button",
              variant: "outline",
              onClick: Message.ClickedCheckSchema(),
              isDisabled: model.schemaCheck._tag === "Checking",
            },
            "Check schema",
            h,
          ),
        ],
      ),
    ],
  );

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
      section({ title: "New type" }, [newTypeForm(model, h)], h),
    ],
  ),
);
