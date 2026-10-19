import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { Command, given, message, model, story } from "foldkit/story";
import { ApiFailure } from "@/domain/entityStore";
import {
  CheckSchema,
  CreateType,
  FetchTypes,
  init,
  Message,
  NavigateToType,
  Submission,
  update,
} from "./main.ts";

const initial = init().model;

const failure = (error: string, code: string) =>
  ApiFailure.make({
    status: 422,
    error,
    code: Option.some(code),
    issues: [{ path: "fields.x", message: "Unknown field type" }],
    report: Option.none(),
    currentRev: Option.none(),
  });

describe("type list", () => {
  it("init fetches the types and shows them when they arrive", () => {
    expect(init().commands?.map((command) => command.name)).toEqual([FetchTypes.name]);
    story(
      update,
      given(initial),
      message(
        Message.SucceededFetchTypes({
          items: [
            { name: "person", description: "", latestVersion: 2, createdAt: 0, updatedAt: 0 },
          ],
        }),
      ),
      model((m) => {
        expect(m.types._tag).toBe("Loaded");
      }),
    );
  });

  it("refuses to submit without a name or with malformed JSON, without calling the API", () => {
    story(
      update,
      given(initial),
      message(Message.SubmittedNewType()),
      Command.expectNone(),
      model((m) =>
        expect(m.submission).toEqual({ _tag: "Invalid", message: "Give the type a name." }),
      ),
      message(Message.UpdatedName({ value: "person" })),
      message(Message.UpdatedSchemaText({ value: "{ fields: " })),
      message(Message.SubmittedNewType()),
      Command.expectNone(),
      model((m) => {
        expect(m.submission._tag).toBe("Invalid");
        if (m.submission._tag === "Invalid") {
          expect(m.submission.message).toMatch(/^Schema isn't valid JSON/);
        }
      }),
    );
  });

  it("creates a type, then navigates to it", () => {
    story(
      update,
      given(initial),
      message(Message.UpdatedName({ value: "  person " })),
      message(Message.UpdatedSchemaText({ value: '{"fields":{}}' })),
      message(Message.SubmittedNewType()),
      model((m) => expect(m.submission._tag).toBe("Submitting")),
      Command.expectHas(CreateType({ name: "person", description: "", schema: { fields: {} } })),
      Command.resolve(CreateType, Message.SucceededCreateType({ name: "person" })),
      Command.expectHas(NavigateToType({ name: "person" })),
      Command.resolve(NavigateToType, Message.CompletedNavigateToType()),
    );
  });

  it("ignores a second submit while one is in flight", () => {
    story(
      update,
      given({ ...initial, name: "person", submission: Submission.Submitting() }),
      message(Message.SubmittedNewType()),
      Command.expectNone(),
    );
  });

  it("keeps the form and shows the API's issues when creation fails", () => {
    story(
      update,
      given(initial),
      message(Message.UpdatedName({ value: "person" })),
      message(Message.SubmittedNewType()),
      Command.resolve(
        CreateType,
        Message.FailedCreateType({
          failure: failure("The schema definition is invalid", "InvalidSchema"),
        }),
      ),
      model((m) => {
        expect(m.name).toBe("person");
        expect(m.submission._tag).toBe("Failed");
      }),
    );
  });

  it("checks the schema and forgets the result when the schema changes", () => {
    story(
      update,
      given(initial),
      message(Message.ClickedCheckSchema()),
      model((m) => expect(m.schemaCheck._tag).toBe("Checking")),
      Command.resolve(CheckSchema, Message.SucceededCheckSchema({ ok: true, issues: [] })),
      model((m) => expect(m.schemaCheck).toEqual({ _tag: "Checked", ok: true, issues: [] })),
      message(Message.UpdatedSchemaText({ value: "{}" })),
      model((m) => expect(m.schemaCheck._tag).toBe("Idle")),
    );
  });
});
