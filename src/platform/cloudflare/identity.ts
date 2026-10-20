import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Principal } from "../../auth/identity.ts";
import { EDGE_HEADER, PRINCIPAL_HEADER, sameSecret } from "./principal.ts";

const decodePrincipal = Schema.decodeUnknownOption(Schema.fromJsonString(Principal));

/**
 * The principal the Website edge forwarded over the service binding. It's
 * trusted only with the edge's shared secret: any other caller (or a client
 * setting these headers itself) is unauthenticated.
 */
export const forwardedPrincipal = (
  headers: Readonly<Record<string, string | undefined>>,
  edgeSecret: string | undefined,
): Option.Option<Principal> => {
  const sent = headers[EDGE_HEADER];
  if (edgeSecret === undefined || edgeSecret === "" || sent === undefined) {
    return Option.none();
  }
  if (!sameSecret(sent, edgeSecret)) {
    return Option.none();
  }
  const principal = headers[PRINCIPAL_HEADER];
  return principal === undefined ? Option.none() : decodePrincipal(principal);
};
