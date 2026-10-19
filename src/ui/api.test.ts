import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { apiUrl, segment, toApiFailure } from "./api.ts";

describe("api helpers", () => {
  it("builds relative URLs under the base path", () => {
    expect(apiUrl("types")).toBe(`${import.meta.env.BASE_URL}api/types`);
    expect(apiUrl(`entities/${segment("a b")}`, { version: "2" })).toBe(
      `${import.meta.env.BASE_URL}api/entities/a%20b?version=2`,
    );
  });

  it("normalizes the API's error body, keeping conflict and validation details", () => {
    const conflict = toApiFailure(409, {
      error: "Entity 'ada' is at rev 4, not 3",
      code: "RevConflict",
      currentRev: 4,
    });
    expect(conflict.code).toEqual(Option.some("RevConflict"));
    expect(conflict.currentRev).toEqual(Option.some(4));
    expect(conflict.issues).toEqual([]);

    const invalid = toApiFailure(422, {
      error: "The schema definition is invalid",
      code: "InvalidSchema",
      issues: [{ path: "fields.x", message: "bad" }],
    });
    expect(invalid.issues).toEqual([{ path: "fields.x", message: "bad" }]);
    expect(Option.isNone(invalid.report)).toBe(true);
  });

  it("falls back to the status when the body isn't the API's error shape", () => {
    const failure = toApiFailure(502, "<html>Bad gateway</html>");
    expect(failure.error).toBe("Request failed with status 502");
    expect(Option.isNone(failure.code)).toBe(true);
  });
});
