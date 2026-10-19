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
import { apiUrl, getJson, postJson, segment } from "@/api";
import { errorAlert, failureAlert, issueList } from "@/components/feedback";
import { jsonBlock } from "@/components/json";
import { pageHeader, section, statusText } from "@/components/layout";
import { selectField } from "@/components/select";
import { badge } from "@/components/ui/badge";
import { button } from "@/components/ui/button";
import { input } from "@/components/ui/input";
import { textarea } from "@/components/ui/textarea";
import {
  AddedVersion,
  ApiFailure,
  Direction,
  Issue,
  LensFunction,
  LensFunctions,
  LensReport,
  LensRun,
  TypeInfo,
  VersionCheck,
} from "@/domain/entityStore";
import { exampleDocument, parseJson, prettyJson } from "@/domain/json";
import { AppRoute, href } from "@/route";
import { lensReportView } from "./report.ts";

export const EMPTY_LENS = `{
  "ops": []
}`;

// MODEL

export const TypeState = defineTaggedUnion({
  Loading: {},
  Failed: { failure: ApiFailure },
  Loaded: { info: TypeInfo },
});
export type TypeState = typeof TypeState.Type;

export const Functions = defineTaggedUnion({
  Loading: {},
  Failed: { failure: ApiFailure },
  Loaded: { items: Schema.Array(LensFunction) },
});
export type Functions = typeof Functions.Type;

export const Check = defineTaggedUnion({
  Idle: {},
  Checking: {},
  Invalid: { message: Schema.String },
  Checked: { from: Schema.Int, to: Schema.Int, report: LensReport },
  Failed: { failure: ApiFailure },
});
export type Check = typeof Check.Type;

export const Submission = defineTaggedUnion({
  Idle: {},
  Submitting: { force: Schema.Boolean },
  Invalid: { message: Schema.String },
  Rejected: { report: LensReport },
  Failed: { failure: ApiFailure },
});
export type Submission = typeof Submission.Type;

export const Trial = defineTaggedUnion({
  Idle: {},
  Running: {},
  Invalid: { message: Schema.String },
  Succeeded: { output: Schema.Json },
  Failed: { error: Schema.String, issues: Schema.Array(Issue) },
});
export type Trial = typeof Trial.Type;

export const Model = Schema.Struct({
  name: Schema.String,
  type: TypeState,
  functions: Functions,
  schemaText: Schema.String,
  lensText: Schema.String,
  note: Schema.String,
  check: Check,
  submission: Submission,
  trialDoc: Schema.String,
  trialDirection: Direction,
  trial: Trial,
});
export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  SucceededFetchType: { info: TypeInfo },
  FailedFetchType: { failure: ApiFailure },
  SucceededFetchFunctions: { items: Schema.Array(LensFunction) },
  FailedFetchFunctions: { failure: ApiFailure },
  UpdatedSchemaText: { value: Schema.String },
  UpdatedLensText: { value: Schema.String },
  UpdatedNote: { value: Schema.String },
  ClickedCheckLens: {},
  SucceededCheckLens: { from: Schema.Int, to: Schema.Int, report: LensReport },
  FailedCheckLens: { failure: ApiFailure },
  SubmittedNewVersion: {},
  ClickedCreateAnyway: {},
  SucceededCreateVersion: {},
  FailedCreateVersion: { failure: ApiFailure },
  CompletedNavigateToType: {},
  UpdatedTrialDoc: { value: Schema.String },
  SelectedTrialDirection: { direction: Direction },
  ClickedRunLens: {},
  SucceededRunLens: { output: Schema.Json },
  FailedRunLens: { error: Schema.String, issues: Schema.Array(Issue) },
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

export const FetchFunctions = Command.define("FetchFunctions", {
  messages: [Message.SucceededFetchFunctions, Message.FailedFetchFunctions],
  execute: getJson(apiUrl("lens/functions"), LensFunctions).pipe(
    Effect.map(({ items }) => Message.SucceededFetchFunctions({ items })),
    Effect.catch((failure) => Effect.succeed(Message.FailedFetchFunctions({ failure }))),
  ),
});

export const CheckLens = Command.define("CheckLens", {
  args: { name: Schema.String, schema: Schema.Json, lens: Schema.Json },
  messages: [Message.SucceededCheckLens, Message.FailedCheckLens],
  execute: ({ name, schema, lens }) =>
    postJson(apiUrl(`types/${segment(name)}/versions/check`), { schema, lens }, VersionCheck).pipe(
      Effect.map(({ from, to, report }) => Message.SucceededCheckLens({ from, to, report })),
      Effect.catch((failure) => Effect.succeed(Message.FailedCheckLens({ failure }))),
    ),
});

export const CreateVersion = Command.define("CreateVersion", {
  args: {
    name: Schema.String,
    schema: Schema.Json,
    lens: Schema.Json,
    note: Schema.String,
    force: Schema.Boolean,
  },
  messages: [Message.SucceededCreateVersion, Message.FailedCreateVersion],
  execute: ({ name, schema, lens, note, force }) =>
    postJson(
      apiUrl(`types/${segment(name)}/versions`),
      { schema, lens, note, force },
      AddedVersion,
    ).pipe(
      Effect.as(Message.SucceededCreateVersion()),
      Effect.catch((failure) => Effect.succeed(Message.FailedCreateVersion({ failure }))),
    ),
});

export const RunLens = Command.define("RunLens", {
  args: { lens: Schema.Json, direction: Direction, doc: Schema.Json },
  messages: [Message.SucceededRunLens, Message.FailedRunLens],
  execute: ({ lens, direction, doc }) =>
    postJson(apiUrl("lens/run"), { lens, direction, doc }, LensRun).pipe(
      Effect.map((run) =>
        Option.match(run.ok ? run.output : Option.none(), {
          onSome: (output) => Message.SucceededRunLens({ output }),
          onNone: () =>
            Message.FailedRunLens({
              error: Option.getOrElse(run.error, () =>
                run.issues === undefined ? "The lens failed" : "The lens definition is invalid",
              ),
              issues: run.issues ?? [],
            }),
        }),
      ),
      Effect.catch((failure) =>
        Effect.succeed(Message.FailedRunLens({ error: failure.error, issues: failure.issues })),
      ),
    ),
});

export const NavigateToType = Command.define("NavigateToType", {
  args: { name: Schema.String },
  messages: [Message.CompletedNavigateToType],
  execute: ({ name }) =>
    pushUrl(href(AppRoute.TypeDetail({ name }))).pipe(Effect.as(Message.CompletedNavigateToType())),
});

// INIT

export const init = (name: string): Update.Return<Model, Message> => ({
  model: Model.make({
    name,
    type: TypeState.Loading(),
    functions: Functions.Loading(),
    schemaText: "",
    lensText: EMPTY_LENS,
    note: "",
    check: Check.Idle(),
    submission: Submission.Idle(),
    trialDoc: "{}",
    trialDirection: "forward",
    trial: Trial.Idle(),
  }),
  commands: [FetchType({ name }), FetchFunctions()],
});

// UPDATE

type UpdateReturn = Update.Return<Model, Message>;

type Draft = Readonly<{ schema: Schema.Json; lens: Schema.Json }>;

/** Parse both editors, naming the one that isn't valid JSON. */
const parseDraft = (model: Model): Result.Result<Draft, string> =>
  Result.flatMap(
    Result.mapError(parseJson(model.schemaText), (error) => `Schema isn't valid JSON: ${error}`),
    (schema) =>
      Result.map(
        Result.mapError(parseJson(model.lensText), (error) => `Lens isn't valid JSON: ${error}`),
        (lens) => ({ schema, lens }),
      ),
  );

const submit = (model: Model, force: boolean): UpdateReturn => {
  if (model.submission._tag === "Submitting") {
    return { model };
  }
  return Result.match(parseDraft(model), {
    onFailure: (message) => ({
      model: modifyFields(model, { submission: () => Submission.Invalid({ message }) }),
    }),
    onSuccess: ({ schema, lens }) => ({
      model: modifyFields(model, { submission: () => Submission.Submitting({ force }) }),
      commands: [CreateVersion({ name: model.name, schema, lens, note: model.note.trim(), force })],
    }),
  });
};

/** A rejected report describes the old draft; editing the draft retires it. */
const resetRejection = (submission: Submission): Submission =>
  submission._tag === "Rejected" ? Submission.Idle() : submission;

const isLensCheckRejection = (failure: ApiFailure) =>
  Option.contains(failure.code, "LensCheckFailed") && Option.isSome(failure.report);

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    SucceededFetchType: ({ info }) => {
      const latest = Array.findFirst(info.versions, (v) => v.version === info.latestVersion);
      return {
        model: modifyFields(model, {
          type: () => TypeState.Loaded({ info }),
          schemaText: (text) =>
            text === ""
              ? Option.match(latest, { onNone: () => "", onSome: (v) => prettyJson(v.schema) })
              : text,
          trialDoc: (doc) =>
            doc === "{}"
              ? Option.match(latest, {
                  onNone: () => doc,
                  onSome: (v) => prettyJson(exampleDocument(v.schema)),
                })
              : doc,
        }),
      };
    },
    FailedFetchType: ({ failure }) => ({
      model: modifyFields(model, { type: () => TypeState.Failed({ failure }) }),
    }),
    SucceededFetchFunctions: ({ items }) => ({
      model: modifyFields(model, { functions: () => Functions.Loaded({ items }) }),
    }),
    FailedFetchFunctions: ({ failure }) => ({
      model: modifyFields(model, { functions: () => Functions.Failed({ failure }) }),
    }),
    UpdatedSchemaText: ({ value }) => ({
      model: modifyFields(model, {
        schemaText: () => value,
        check: () => Check.Idle(),
        submission: resetRejection,
      }),
    }),
    UpdatedLensText: ({ value }) => ({
      model: modifyFields(model, {
        lensText: () => value,
        check: () => Check.Idle(),
        submission: resetRejection,
      }),
    }),
    UpdatedNote: ({ value }) => ({ model: modifyFields(model, { note: () => value }) }),
    ClickedCheckLens: () => {
      if (model.check._tag === "Checking") {
        return { model };
      }
      return Result.match(parseDraft(model), {
        onFailure: (message) => ({
          model: modifyFields(model, { check: () => Check.Invalid({ message }) }),
        }),
        onSuccess: ({ schema, lens }) => ({
          model: modifyFields(model, { check: () => Check.Checking() }),
          commands: [CheckLens({ name: model.name, schema, lens })],
        }),
      });
    },
    SucceededCheckLens: ({ from, to, report }) => ({
      model: modifyFields(model, { check: () => Check.Checked({ from, to, report }) }),
    }),
    FailedCheckLens: ({ failure }) => ({
      model: modifyFields(model, { check: () => Check.Failed({ failure }) }),
    }),
    SubmittedNewVersion: () => submit(model, false),
    ClickedCreateAnyway: () => submit(model, true),
    SucceededCreateVersion: () => ({
      model,
      commands: [NavigateToType({ name: model.name })],
    }),
    FailedCreateVersion: ({ failure }) => ({
      model: modifyFields(model, {
        submission: () =>
          Option.match(
            Option.filter(failure.report, () => isLensCheckRejection(failure)),
            {
              onNone: () => Submission.Failed({ failure }),
              onSome: (report) => Submission.Rejected({ report }),
            },
          ),
      }),
    }),
    CompletedNavigateToType: () => ({ model }),
    UpdatedTrialDoc: ({ value }) => ({ model: modifyFields(model, { trialDoc: () => value }) }),
    SelectedTrialDirection: ({ direction }) => ({
      model: modifyFields(model, { trialDirection: () => direction, trial: () => Trial.Idle() }),
    }),
    ClickedRunLens: () => {
      if (model.trial._tag === "Running") {
        return { model };
      }
      const parsed = Result.flatMap(
        Result.mapError(parseJson(model.lensText), (error) => `Lens isn't valid JSON: ${error}`),
        (lens) =>
          Result.map(
            Result.mapError(
              parseJson(model.trialDoc),
              (error) => `Document isn't valid JSON: ${error}`,
            ),
            (doc) => ({ lens, doc }),
          ),
      );
      return Result.match(parsed, {
        onFailure: (message) => ({
          model: modifyFields(model, { trial: () => Trial.Invalid({ message }) }),
        }),
        onSuccess: ({ lens, doc }) => ({
          model: modifyFields(model, { trial: () => Trial.Running() }),
          commands: [RunLens({ lens, direction: model.trialDirection, doc })],
        }),
      });
    },
    SucceededRunLens: ({ output }) => ({
      model: modifyFields(model, { trial: () => Trial.Succeeded({ output }) }),
    }),
    FailedRunLens: ({ error, issues }) => ({
      model: modifyFields(model, { trial: () => Trial.Failed({ error, issues }) }),
    }),
  });

// VIEW

const LENS_OPS: ReadonlyArray<readonly [string, string]> = [
  ['{ "op": "rename", "from": "a", "to": "b" }', "Rename a field (back: rename back)."],
  [
    '{ "op": "add", "field": "f", "default": 0 }',
    "Set a default when absent; omit default for optional fields (back: remove).",
  ],
  ['{ "op": "remove", "field": "f", "default": 0 }', "Drop a field (back: restore default)."],
  [
    '{ "op": "convert", "field": "s", "mapping": [["old", "new"]] }',
    "Map values; optional fallback { forward, backward }.",
  ],
  ['{ "op": "in", "field": "obj", "ops": [ … ] }', "Run ops inside an object field."],
  ['{ "op": "each", "field": "list", "ops": [ … ] }', "Run ops on each object in an array."],
  ['{ "op": "hoist", "host": "h", "field": "f" }', "Move h.f up to f (back: plunge)."],
  ['{ "op": "plunge", "host": "h", "field": "f" }', "Move f into h.f (back: hoist)."],
  [
    '{ "op": "derive", "forward": { "full": "a + \' \' + b" }, "backward": { "a": "split(full, \' \')[0]" } }',
    "Compute fields with expressions, one map per direction.",
  ],
];

const functionSignature = (fn: LensFunction) =>
  Option.match(fn.maxArgs, {
    onNone: () => `${fn.name}(${fn.minArgs}+ args)`,
    onSome: (max) =>
      max === fn.minArgs ? `${fn.name}(${max} args)` : `${fn.name}(${fn.minArgs}–${max} args)`,
  });

const cheatSheet = (functions: Functions, h: HtmlBuilder<Message>): Html =>
  section(
    { title: "Lens reference" },
    [
      h.div(
        [h.Class("space-y-4 text-xs")],
        [
          h.p(
            [h.Class("text-muted-foreground")],
            [
              'A lens is { "ops": [...] }. Forward runs the ops in order (old → new); backward undoes them in reverse.',
            ],
          ),
          h.ul(
            [h.Class("space-y-2")],
            Array.map(LENS_OPS, ([example, description]) =>
              h.keyed("li")(
                example,
                [h.Class("space-y-0.5")],
                [
                  h.code([h.Class("block break-all font-mono text-foreground")], [example]),
                  h.span([h.Class("text-muted-foreground")], [description]),
                ],
              ),
            ),
          ),
          h.div(
            [h.Class("space-y-1")],
            [
              h.h3([h.Class("text-sm font-medium")], ["Expressions"]),
              h.p(
                [h.Class("text-muted-foreground")],
                [
                  "Field names, $ (whole document), .field, [index], + - * / %, == != < <= > >=, && || ??, c ? a : b, [arrays], { objects }, and x => … in map/filter.",
                ],
              ),
            ],
          ),
          Functions.match(functions, {
            Loading: () => statusText("Loading functions…", h),
            Failed: ({ failure }) => failureAlert(failure, h),
            Loaded: ({ items }) =>
              h.dl(
                [h.Class("grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1")],
                Array.flatMap(items, (fn) => [
                  h.keyed("dt")(
                    `${fn.name}-name`,
                    [h.Class("font-mono"), h.Title(functionSignature(fn))],
                    [fn.name],
                  ),
                  h.keyed("dd")(`${fn.name}-doc`, [h.Class("text-muted-foreground")], [fn.doc]),
                ]),
              ),
          }),
        ],
      ),
    ],
    h,
  );

const checkView = (check: Check, h: HtmlBuilder<Message>): Html =>
  Check.match(check, {
    Idle: () => h.empty,
    Checking: () => statusText("Checking lens against random and stored documents…", h),
    Invalid: ({ message }) => errorAlert(message, h),
    Checked: ({ from, to, report }) =>
      lensReportView(report, { from: Option.some(from), to: Option.some(to) }, h),
    Failed: ({ failure }) => failureAlert(failure, h),
  });

const submissionView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Submission.match(model.submission, {
    Idle: () => h.empty,
    Submitting: () => statusText("Creating version…", h),
    Invalid: ({ message }) => errorAlert(message, h),
    Rejected: ({ report }) =>
      h.div(
        [h.Class("space-y-3")],
        [
          errorAlert(
            "The lens produced invalid documents, so the version wasn't created. Fix the lens, or create it anyway.",
            h,
          ),
          button(
            { type: "button", variant: "destructive", onClick: Message.ClickedCreateAnyway() },
            "Create anyway",
            h,
          ),
          lensReportView(report, { from: Option.none(), to: Option.none() }, h),
        ],
      ),
    Failed: ({ failure }) => failureAlert(failure, h),
  });

const trialResultView = (trial: Trial, h: HtmlBuilder<Message>): Html =>
  Trial.match(trial, {
    Idle: () => h.empty,
    Running: () => statusText("Running lens…", h),
    Invalid: ({ message }) => errorAlert(message, h),
    Succeeded: ({ output }) =>
      h.div(
        [h.Class("space-y-1")],
        [
          h.div([h.Class("text-xs font-medium text-muted-foreground")], ["Output"]),
          jsonBlock(output, h, { label: "Lens output" }),
        ],
      ),
    Failed: ({ error, issues }) =>
      h.div(
        [
          h.Class(
            "rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive",
          ),
          h.Role("alert"),
        ],
        [h.span([h.Class("font-medium")], [error]), issueList(issues, h)],
      ),
  });

const trialView = (model: Model, h: HtmlBuilder<Message>): Html =>
  section(
    {
      title: "Try the lens",
      actions: [
        selectField(
          {
            id: "trial-direction",
            label: "Direction",
            value: model.trialDirection,
            options: [
              { value: "forward", label: "Forward (old → new)" },
              { value: "backward", label: "Backward (new → old)" },
            ],
            onChange: (value) =>
              Message.SelectedTrialDirection({
                direction: value === "backward" ? "backward" : "forward",
              }),
          },
          h,
        ),
      ],
    },
    [
      h.div(
        [h.Class("space-y-3")],
        [
          textarea(
            {
              id: "trial-doc",
              label:
                model.trialDirection === "forward"
                  ? "Old-version document"
                  : "New-version document",
              value: model.trialDoc,
              rows: 6,
              onInput: (value) => Message.UpdatedTrialDoc({ value }),
              className: "max-h-80 font-mono text-xs",
            },
            h,
          ),
          button(
            {
              type: "button",
              variant: "outline",
              onClick: Message.ClickedRunLens(),
              isDisabled: model.trial._tag === "Running",
            },
            "Run lens",
            h,
          ),
          trialResultView(model.trial, h),
        ],
      ),
    ],
    h,
  );

const editorView = (model: Model, info: TypeInfo, h: HtmlBuilder<Message>): Html =>
  section(
    { title: `Define v${info.latestVersion + 1}` },
    [
      h.form(
        [
          h.OnSubmit(Message.SubmittedNewVersion()),
          h.Class("space-y-4"),
          h.AriaLabel("New version"),
        ],
        [
          h.div(
            [h.Class("grid gap-4 xl:grid-cols-2")],
            [
              textarea(
                {
                  id: "version-schema",
                  label: `Schema v${info.latestVersion + 1} (JSON)`,
                  description: `Starts from v${info.latestVersion}.`,
                  value: model.schemaText,
                  rows: 18,
                  onInput: (value) => Message.UpdatedSchemaText({ value }),
                  className: "max-h-[36rem] font-mono text-xs",
                },
                h,
              ),
              textarea(
                {
                  id: "version-lens",
                  label: `Lens v${info.latestVersion} → v${info.latestVersion + 1} (JSON)`,
                  description: "Ops run forward on old data and backward for old readers.",
                  value: model.lensText,
                  rows: 18,
                  onInput: (value) => Message.UpdatedLensText({ value }),
                  className: "max-h-[36rem] font-mono text-xs",
                },
                h,
              ),
            ],
          ),
          input(
            {
              id: "version-note",
              label: "Note (optional)",
              value: model.note,
              placeholder: "What changed and why",
              onInput: (value) => Message.UpdatedNote({ value }),
            },
            h,
          ),
          h.div(
            [h.Class("flex flex-wrap gap-2")],
            [
              button(
                {
                  type: "button",
                  variant: "outline",
                  onClick: Message.ClickedCheckLens(),
                  isDisabled: model.check._tag === "Checking",
                },
                model.check._tag === "Checking" ? "Checking…" : "Check lens",
                h,
              ),
              button(
                { type: "submit", isDisabled: model.submission._tag === "Submitting" },
                model.submission._tag === "Submitting" ? "Creating…" : "Create version",
                h,
              ),
            ],
          ),
          submissionView(model, h),
          checkView(model.check, h),
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
            " /",
          ],
          title: "New version",
          actions: [
            badge(
              { variant: "secondary" },
              [`v${info.latestVersion} → v${info.latestVersion + 1}`],
              h,
            ),
          ],
        },
        h,
      ),
      h.div(
        [h.Class("grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]")],
        [
          h.div([h.Class("min-w-0 space-y-6")], [editorView(model, info, h), trialView(model, h)]),
          h.div([h.Class("min-w-0")], [cheatSheet(model.functions, h)]),
        ],
      ),
    ],
  );

export const view = Submodel.defineView<Model, Message>((model, h): Html =>
  TypeState.match(model.type, {
    Loading: () => statusText(`Loading ${model.name}…`, h),
    Failed: ({ failure }) =>
      h.div(
        [h.Class("space-y-4")],
        [pageHeader({ title: "New version" }, h), failureAlert(failure, h)],
      ),
    Loaded: ({ info }) => loadedView(model, info, h),
  }),
);
