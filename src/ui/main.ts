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
import { apiUrl, getJson } from "@/api";
import { buttonClass } from "@/components/ui/button";
import { pageHeader } from "@/components/layout";
import { ApiFailure, TypeList as TypeListResponse } from "@/domain/entityStore";
import { EntityDetail, NewVersion, TypeDetail, TypeIndexes, TypeList } from "./page/index.ts";
import { AppRoute, href, urlToAppRoute } from "./route.ts";

// MODEL

export const Page = defineTaggedUnion({
  TypeList: { model: TypeList.Model },
  TypeDetail: { model: TypeDetail.Model },
  NewVersion: { model: NewVersion.Model },
  TypeIndexes: { model: TypeIndexes.Model },
  EntityDetail: { model: EntityDetail.Model },
  NotFound: { path: Schema.String },
});
export type Page = typeof Page.Type;

/** The type names the hub's sidebar lists, fetched once for every page. */
export const NavTypes = defineTaggedUnion({
  Loading: {},
  Failed: { failure: ApiFailure },
  Loaded: { names: Schema.Array(Schema.String) },
});
export type NavTypes = typeof NavTypes.Type;

export const Model = Schema.Struct({ page: Page, navTypes: NavTypes });
export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  ClickedLink: { request: UrlRequest },
  ChangedUrl: { url: Url },
  CompletedNavigateInternal: {},
  CompletedLoadExternal: {},
  SucceededFetchNavTypes: { names: Schema.Array(Schema.String) },
  FailedFetchNavTypes: { failure: ApiFailure },
  GotTypeListMessage: { message: TypeList.Message },
  GotTypeDetailMessage: { message: TypeDetail.Message },
  GotNewVersionMessage: { message: NewVersion.Message },
  GotTypeIndexesMessage: { message: TypeIndexes.Message },
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

export const FetchNavTypes = Command.define("FetchNavTypes", {
  messages: [Message.SucceededFetchNavTypes, Message.FailedFetchNavTypes],
  execute: getJson(apiUrl("types"), TypeListResponse).pipe(
    Effect.map(({ items }) =>
      Message.SucceededFetchNavTypes({ names: items.map((type) => type.name) }),
    ),
    Effect.catch((failure) => Effect.succeed(Message.FailedFetchNavTypes({ failure }))),
  ),
});

// INIT

type UpdateReturn = Update.Return<Model, Message>;
type PageReturn = Update.Return<Page, Message>;

/** Every route starts its page afresh, with that page's initial Commands. */
export const pageForRoute = (route: AppRoute): PageReturn =>
  AppRoute.match<PageReturn>(route, {
    TypeList: () =>
      Update.foldChildInit(TypeList.init(), {
        toParentModel: (model) => Page.TypeList({ model }),
        toParentMessage: (message) => Message.GotTypeListMessage({ message }),
      }),
    TypeDetail: ({ name }) =>
      Update.foldChildInit(TypeDetail.init(name), {
        toParentModel: (model) => Page.TypeDetail({ model }),
        toParentMessage: (message) => Message.GotTypeDetailMessage({ message }),
      }),
    NewVersion: ({ name }) =>
      Update.foldChildInit(NewVersion.init(name), {
        toParentModel: (model) => Page.NewVersion({ model }),
        toParentMessage: (message) => Message.GotNewVersionMessage({ message }),
      }),
    TypeIndexes: ({ name }) =>
      Update.foldChildInit(TypeIndexes.init(name), {
        toParentModel: (model) => Page.TypeIndexes({ model }),
        toParentMessage: (message) => Message.GotTypeIndexesMessage({ message }),
      }),
    EntityDetail: ({ id }) =>
      Update.foldChildInit(EntityDetail.init(id), {
        toParentModel: (model) => Page.EntityDetail({ model }),
        toParentMessage: (message) => Message.GotEntityDetailMessage({ message }),
      }),
    NotFound: ({ path }) => ({ model: Page.NotFound({ path }) }),
  });

export const init = (url: Url): UpdateReturn => {
  const routed = pageForRoute(urlToAppRoute(url));
  return {
    model: Model.make({ page: routed.model, navTypes: NavTypes.Loading() }),
    commands: [...(routed.commands ?? []), FetchNavTypes()],
  };
};

// UPDATE

const foldTypeList = Update.foldChild({
  update: TypeList.update,
  foldOutMessage: (outMessage) =>
    TypeList.OutMessage.match(outMessage, {
      CreatedType:
        () =>
        (stepModel: Model): UpdateReturn => ({
          model: stepModel,
          commands: [FetchNavTypes()],
        }),
    }),
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
  foldOutMessage: (outMessage) =>
    TypeDetail.OutMessage.match(outMessage, {
      ChangedTypes:
        () =>
        (stepModel: Model): UpdateReturn => ({
          model: stepModel,
          commands: [FetchNavTypes()],
        }),
    }),
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

const foldTypeIndexes = Update.foldChild({
  update: TypeIndexes.update,
  read: (model: Model) =>
    Page.matchOrElse(model.page, { TypeIndexes: ({ model: page }) => Option.some(page) }, () =>
      Option.none(),
    ),
  write: (model, nextTypeIndexes) =>
    modifyFields(model, { page: () => Page.TypeIndexes({ model: nextTypeIndexes }) }),
  toParentMessage: (message) => Message.GotTypeIndexesMessage({ message }),
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
    ChangedUrl: ({ url }) => {
      const routed = pageForRoute(urlToAppRoute(url));
      return {
        model: modifyFields(model, { page: () => routed.model }),
        commands: routed.commands,
      };
    },
    CompletedNavigateInternal: () => ({ model }),
    CompletedLoadExternal: () => ({ model }),
    SucceededFetchNavTypes: ({ names }) => ({
      model: modifyFields(model, { navTypes: () => NavTypes.Loaded({ names }) }),
    }),
    FailedFetchNavTypes: ({ failure }) => ({
      model: modifyFields(model, { navTypes: () => NavTypes.Failed({ failure }) }),
    }),
    GotTypeListMessage: ({ message: pageMessage }) => foldTypeList(model, pageMessage),
    GotTypeDetailMessage: ({ message: pageMessage }) => foldTypeDetail(model, pageMessage),
    GotNewVersionMessage: ({ message: pageMessage }) => foldNewVersion(model, pageMessage),
    GotTypeIndexesMessage: ({ message: pageMessage }) => foldTypeIndexes(model, pageMessage),
    GotEntityDetailMessage: ({ message: pageMessage }) => foldEntityDetail(model, pageMessage),
  });

// VIEW

const title = (page: Page): string =>
  Page.match(page, {
    TypeList: () => "Entity store",
    TypeDetail: ({ model }) => `${model.name} · Entity store`,
    NewVersion: ({ model }) => `New version of ${model.name} · Entity store`,
    TypeIndexes: ({ model }) => `${model.name} indexes · Entity store`,
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
    TypeIndexes: ({ model }) =>
      h.submodel({
        slotId: "type-indexes",
        model,
        view: TypeIndexes.view,
        toParentMessage: (message) => Message.GotTypeIndexesMessage({ message }),
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

/** The panel header's label: where the open page sits. */
const headerTitle = (page: Page): string =>
  Page.match(page, {
    TypeList: () => "Entity types",
    TypeDetail: ({ model }) => model.name,
    NewVersion: ({ model }) => `${model.name} · New version`,
    TypeIndexes: ({ model }) => `${model.name} · Indexes`,
    EntityDetail: ({ model }) => model.id,
    NotFound: () => "Not found",
  });

/**
 * The white panel beside the hub's sidebar, as in the platform's other apps: a slim header over
 * the page. The hub shell draws the sidebar, the app's name and its navigation.
 */
export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: title(model.page),
  body: h.div(
    [h.Class("flex min-h-full flex-col bg-background lg:h-full")],
    [
      h.header(
        [h.Class("flex h-12 shrink-0 items-center gap-4 border-b px-4")],
        [
          h.div(
            [h.Class("truncate text-sm font-medium tracking-tight")],
            [headerTitle(model.page)],
          ),
        ],
      ),
      h.main(
        [h.Class("flex-1 px-4 py-5 sm:px-6 sm:py-6 lg:min-h-0 lg:overflow-y-auto")],
        [h.div([h.Class("max-w-6xl")], [pageView(model.page, h)])],
      ),
    ],
  ),
});
