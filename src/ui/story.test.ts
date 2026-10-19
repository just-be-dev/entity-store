import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { Command, given, message, model, story } from "foldkit/story";
import type { Url } from "foldkit/url";
import { apiFailure, personType } from "@/domain/entityStore.fixture";
import { init, Message, NavigateInternal, Page, update } from "./main.ts";
import { TypeDetail, TypeList } from "./page/index.ts";

const url = (pathname: string): Url => ({
  protocol: "http:",
  host: "localhost",
  port: Option.none(),
  pathname,
  search: Option.none(),
  hash: Option.none(),
});

describe("root", () => {
  it("starts the page for the URL with that page's commands", () => {
    const home = init(url("/"));
    expect(home.model.page._tag).toBe("TypeList");
    expect(home.commands?.map((c) => c.name)).toEqual([TypeList.FetchTypes.name]);

    const entity = init(url("/entities/ada"));
    expect(entity.model.page._tag).toBe("EntityDetail");
    expect(entity.commands).toHaveLength(3);

    expect(init(url("/nowhere")).model.page).toEqual(Page.NotFound({ path: "/nowhere" }));
  });

  it("switches pages on URL changes and routes page results to the active page", () => {
    story(
      update,
      given(init(url("/")).model),
      message(Message.ChangedUrl({ url: url("/types/person") })),
      model((m) => expect(m.page._tag).toBe("TypeDetail")),
      Command.resolve(
        TypeDetail.FetchType,
        TypeDetail.Message.SucceededFetchType({ info: personType }),
      ),
      model((m) => {
        expect(m.page._tag === "TypeDetail" && m.page.model.type._tag).toBe("Loaded");
      }),
      Command.resolve(
        TypeDetail.FetchEntities,
        TypeDetail.Message.FailedFetchEntities({
          version: 2,
          failure: apiFailure(500, "StorageFailure", "Storage error"),
        }),
      ),
      model((m) => {
        expect(m.page._tag === "TypeDetail" && m.page.model.entities._tag).toBe("Failed");
      }),
    );
  });

  it("drops results meant for a page that is no longer shown", () => {
    const onTypePage = init(url("/types/person")).model;
    story(
      update,
      given(onTypePage),
      message(
        Message.GotTypeListMessage({ message: TypeList.Message.UpdatedName({ value: "x" }) }),
      ),
      model((m) => expect(m).toEqual(onTypePage)),
    );
  });

  it("navigates internal links with pushState", () => {
    story(
      update,
      given(init(url("/")).model),
      message(Message.ClickedLink({ request: { _tag: "Internal", url: url("/types/person") } })),
      Command.expectHas(NavigateInternal({ url: "http://localhost/types/person" })),
      Command.resolve(NavigateInternal, Message.CompletedNavigateInternal()),
    );
  });
});
