import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Update } from "foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { UrlRequest, load, pushUrl } from "foldkit/navigation";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";
import { Url, toString as urlToString } from "foldkit/url";
import { buttonClass } from "@/components/ui/button";
import { pageHeader } from "@/components/layout";
import { EntityDetail, NewVersion, TypeDetail, TypeList } from "./page/index.ts";
import { AppRoute, href, urlToAppRoute } from "./route.ts";

// MODEL

export const Page = defineTaggedUnion({
  TypeList: { model: TypeList.Model },
  TypeDetail: { model: TypeDetail.Model },
  NewVersion: { model: NewVersion.Model },
  EntityDetail: { model: EntityDetail.Model },
  NotFound: { path: Schema.String },
});
export type Page = typeof Page.Type;

export const Model = Schema.Struct({ page: Page });
export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  ClickedLink: { request: UrlRequest },
  ChangedUrl: { url: Url },
  CompletedNavigateInternal: {},
  CompletedLoadExternal: {},
  GotTypeListMessage: { message: TypeList.Message },
  GotTypeDetailMessage: { message: TypeDetail.Message },
  GotNewVersionMessage: { message: NewVersion.Message },
  GotEntityDetailMessage: { message: EntityDetail.Message },
});
export type Message = typeof Message.Type;

// COMMAND

export const NavigateInternal = Command.define("NavigateInternal", {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigateInternal],
  execute: ({ url }) => pushUrl(url).pipe(Effect.as(Message.CompletedNavigateInternal())),
});

export const LoadExternal = Command.define("LoadExternal", {
  args: { href: Schema.String },
  messages: [Message.CompletedLoadExternal],
  execute: ({ href: url }) => load(url).pipe(Effect.as(Message.CompletedLoadExternal())),
});

// INIT

type UpdateReturn = Update.Return<Model, Message>;

const toModel = (page: Page): Model => Model.make({ page });

/** Every route starts its page afresh, with that page's initial Commands. */
export const pageForRoute = (route: AppRoute): UpdateReturn =>
  AppRoute.match<UpdateReturn>(route, {
    TypeList: () =>
      Update.foldChildInit(TypeList.init(), {
        toParentModel: (model) => toModel(Page.TypeList({ model })),
        toParentMessage: (message) => Message.GotTypeListMessage({ message }),
      }),
    TypeDetail: ({ name }) =>
      Update.foldChildInit(TypeDetail.init(name), {
        toParentModel: (model) => toModel(Page.TypeDetail({ model })),
        toParentMessage: (message) => Message.GotTypeDetailMessage({ message }),
      }),
    NewVersion: ({ name }) =>
      Update.foldChildInit(NewVersion.init(name), {
        toParentModel: (model) => toModel(Page.NewVersion({ model })),
        toParentMessage: (message) => Message.GotNewVersionMessage({ message }),
      }),
    EntityDetail: ({ id }) =>
      Update.foldChildInit(EntityDetail.init(id), {
        toParentModel: (model) => toModel(Page.EntityDetail({ model })),
        toParentMessage: (message) => Message.GotEntityDetailMessage({ message }),
      }),
    NotFound: ({ path }) => ({ model: toModel(Page.NotFound({ path })) }),
  });

export const init = (url: Url): UpdateReturn => pageForRoute(urlToAppRoute(url));

// UPDATE

const foldTypeList = Update.foldChild({
  update: TypeList.update,
  read: (model: Model) =>
    Page.matchOrElse(model.page, { TypeList: ({ model: page }) => Option.some(page) }, () =>
      Option.none(),
    ),
  write: (model, nextTypeList) =>
    modifyFields(model, { page: () => Page.TypeList({ model: nextTypeList }) }),
  toParentMessage: (message) => Message.GotTypeListMessage({ message }),
});

const foldTypeDetail = Update.foldChild({
  update: TypeDetail.update,
  read: (model: Model) =>
    Page.matchOrElse(model.page, { TypeDetail: ({ model: page }) => Option.some(page) }, () =>
      Option.none(),
    ),
  write: (model, nextTypeDetail) =>
    modifyFields(model, { page: () => Page.TypeDetail({ model: nextTypeDetail }) }),
  toParentMessage: (message) => Message.GotTypeDetailMessage({ message }),
});

const foldNewVersion = Update.foldChild({
  update: NewVersion.update,
  read: (model: Model) =>
    Page.matchOrElse(model.page, { NewVersion: ({ model: page }) => Option.some(page) }, () =>
      Option.none(),
    ),
  write: (model, nextNewVersion) =>
    modifyFields(model, { page: () => Page.NewVersion({ model: nextNewVersion }) }),
  toParentMessage: (message) => Message.GotNewVersionMessage({ message }),
});

const foldEntityDetail = Update.foldChild({
  update: EntityDetail.update,
  read: (model: Model) =>
    Page.matchOrElse(model.page, { EntityDetail: ({ model: page }) => Option.some(page) }, () =>
      Option.none(),
    ),
  write: (model, nextEntityDetail) =>
    modifyFields(model, { page: () => Page.EntityDetail({ model: nextEntityDetail }) }),
  toParentMessage: (message) => Message.GotEntityDetailMessage({ message }),
});

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ClickedLink: ({ request }) =>
      UrlRequest.match<UpdateReturn>(request, {
        Internal: ({ url }) => ({
          model,
          commands: [NavigateInternal({ url: urlToString(url) })],
        }),
        External: ({ href: url }) => ({ model, commands: [LoadExternal({ href: url })] }),
      }),
    ChangedUrl: ({ url }) => pageForRoute(urlToAppRoute(url)),
    CompletedNavigateInternal: () => ({ model }),
    CompletedLoadExternal: () => ({ model }),
    GotTypeListMessage: ({ message: pageMessage }) => foldTypeList(model, pageMessage),
    GotTypeDetailMessage: ({ message: pageMessage }) => foldTypeDetail(model, pageMessage),
    GotNewVersionMessage: ({ message: pageMessage }) => foldNewVersion(model, pageMessage),
    GotEntityDetailMessage: ({ message: pageMessage }) => foldEntityDetail(model, pageMessage),
  });

// VIEW

const title = (page: Page): string =>
  Page.match(page, {
    TypeList: () => "Entity store",
    TypeDetail: ({ model }) => `${model.name} · Entity store`,
    NewVersion: ({ model }) => `New version of ${model.name} · Entity store`,
    EntityDetail: ({ model }) => `${model.id} · Entity store`,
    NotFound: () => "Not found · Entity store",
  });

const notFoundView = (path: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("space-y-4")],
    [
      pageHeader({ title: "Page not found", description: `Nothing lives at ${path}.` }, h),
      h.a(
        [h.Href(href(AppRoute.TypeList())), h.Class(buttonClass({ variant: "outline" }))],
        ["All types"],
      ),
    ],
  );

const pageView = (page: Page, h: HtmlBuilder<Message>): Html =>
  Page.match(page, {
    TypeList: ({ model }) =>
      h.submodel({
        slotId: "type-list",
        model,
        view: TypeList.view,
        toParentMessage: (message) => Message.GotTypeListMessage({ message }),
      }),
    TypeDetail: ({ model }) =>
      h.submodel({
        slotId: "type-detail",
        model,
        view: TypeDetail.view,
        toParentMessage: (message) => Message.GotTypeDetailMessage({ message }),
      }),
    NewVersion: ({ model }) =>
      h.submodel({
        slotId: "new-version",
        model,
        view: NewVersion.view,
        toParentMessage: (message) => Message.GotNewVersionMessage({ message }),
      }),
    EntityDetail: ({ model }) =>
      h.submodel({
        slotId: "entity-detail",
        model,
        view: EntityDetail.view,
        toParentMessage: (message) => Message.GotEntityDetailMessage({ message }),
      }),
    NotFound: ({ path }) => notFoundView(path, h),
  });

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: title(model.page),
  body: h.div(
    [h.Class("min-h-screen")],
    [
      h.header(
        [h.Class("border-b border-border bg-card")],
        [
          h.nav(
            [
              h.Class("mx-auto flex max-w-6xl items-center gap-4 px-4 py-3 sm:px-6"),
              h.AriaLabel("Main"),
            ],
            [
              h.a(
                [
                  h.Href(href(AppRoute.TypeList())),
                  h.Class("font-mono text-sm font-semibold tracking-tight"),
                ],
                ["entity-store"],
              ),
              h.a(
                [
                  h.Href(href(AppRoute.TypeList())),
                  h.Class("text-sm text-muted-foreground hover:text-foreground"),
                  ...(model.page._tag === "TypeList" ? [h.AriaCurrent("page")] : []),
                ],
                ["Types"],
              ),
            ],
          ),
        ],
      ),
      h.main([h.Class("mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8")], [pageView(model.page, h)]),
    ],
  ),
});
