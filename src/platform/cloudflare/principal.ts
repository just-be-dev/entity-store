import type { Principal } from "../../auth/identity.ts";

// Pure helpers shared by the Website edge (a plain async Worker) and the API
// Worker. No Alchemy or Effect imports, so the edge bundle stays small.

/** Headers the edge sets (after deleting any the client sent). */
export const PRINCIPAL_HEADER = "x-entity-store-principal";
export const EDGE_HEADER = "x-entity-store-edge";

/** The subset of Access's identity payload the principal comes from. */
export interface AccessIdentity {
  readonly email?: string;
  readonly common_name?: string;
  readonly service_token_id?: string;
  readonly [key: string]: unknown;
}

/**
 * The principal for a request Access admitted. A service-token request may
 * have no identity payload at all; Access still admitted it, so it's a
 * service token.
 */
export const principalFromAccess = (identity: AccessIdentity | undefined): Principal =>
  typeof identity?.email === "string" && identity.email !== ""
    ? { _tag: "User", email: identity.email }
    : {
        _tag: "ServiceToken",
        name: identity?.common_name ?? identity?.service_token_id ?? "service-token",
      };

/** Compare secrets without leaking where they differ through timing. */
export const sameSecret = (a: string, b: string): boolean => {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let difference = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return difference === 0;
};
