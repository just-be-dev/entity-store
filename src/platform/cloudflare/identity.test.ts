import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { forwardedPrincipal } from "./identity.ts";
import { EDGE_HEADER, PRINCIPAL_HEADER, principalFromAccess, sameSecret } from "./principal.ts";

const secret = "a".repeat(64);
const user = JSON.stringify({ _tag: "User", email: "cf@just-be.dev" });

describe("principals from Cloudflare Access", () => {
  it("uses the email for people and the token name for service tokens", () => {
    expect(principalFromAccess({ email: "cf@just-be.dev" })).toEqual({
      _tag: "User",
      email: "cf@just-be.dev",
    });
    expect(principalFromAccess({ common_name: "abc.access" })).toEqual({
      _tag: "ServiceToken",
      name: "abc.access",
    });
    // Access admitted the request, so no identity payload still means a token.
    expect(principalFromAccess(undefined)).toEqual({ _tag: "ServiceToken", name: "service-token" });
  });
});

describe("principals forwarded by the edge", () => {
  it("trusts a forwarded principal only with the edge secret", () => {
    expect(forwardedPrincipal({ [EDGE_HEADER]: secret, [PRINCIPAL_HEADER]: user }, secret)).toEqual(
      Option.some({ _tag: "User", email: "cf@just-be.dev" }),
    );
  });

  it("treats forged, missing, or malformed headers as unauthenticated", () => {
    const cases: ReadonlyArray<[Record<string, string>, string | undefined]> = [
      [{ [PRINCIPAL_HEADER]: user }, secret],
      [{ [EDGE_HEADER]: "b".repeat(64), [PRINCIPAL_HEADER]: user }, secret],
      [{ [EDGE_HEADER]: secret.slice(1), [PRINCIPAL_HEADER]: user }, secret],
      [{ [EDGE_HEADER]: secret }, secret],
      [{ [EDGE_HEADER]: secret, [PRINCIPAL_HEADER]: "{not json" }, secret],
      [{ [EDGE_HEADER]: secret, [PRINCIPAL_HEADER]: '{"_tag":"Admin"}' }, secret],
      [{ [EDGE_HEADER]: "", [PRINCIPAL_HEADER]: user }, ""],
      [{ [EDGE_HEADER]: secret, [PRINCIPAL_HEADER]: user }, undefined],
    ];
    for (const [headers, expected] of cases) {
      expect(forwardedPrincipal(headers, expected)).toEqual(Option.none());
    }
  });

  it("compares secrets exactly", () => {
    expect(sameSecret("abc", "abc")).toBe(true);
    expect(sameSecret("abc", "abd")).toBe(false);
    expect(sameSecret("abc", "abcd")).toBe(false);
    expect(sameSecret("", "")).toBe(true);
  });
});
