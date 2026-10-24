import { expect, it } from "@effect/vitest";
import { hubAudience, hubFramePrefix, HUB_APP_ID, TRUSTED_HUB_STAGE } from "./hub-frame.ts";

it("every stage trusts hub prod, under the hub registry's id", () => {
  expect(TRUSTED_HUB_STAGE).toBe("prod");
  expect(HUB_APP_ID).toBe("entities");
});

it("scopes identity tokens to this stage, by the registry id", () => {
  expect(hubAudience("prod")).toBe("entities@prod");
  expect(hubAudience("b-feature-1a2b3c")).toBe("entities@b-feature-1a2b3c");
});

it("puts prod at /entities and a preview at /entities@<stage> on the hub", () => {
  expect(hubFramePrefix("prod")).toBe("/entities");
  expect(hubFramePrefix("b-feature-1a2b3c")).toBe("/entities@b-feature-1a2b3c");
});
