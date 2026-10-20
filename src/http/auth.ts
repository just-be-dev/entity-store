import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Identity } from "../auth/identity.ts";
import { Unauthenticated } from "./response.ts";

/** The request's principal, or `401 Unauthenticated` when there is none. */
export const requirePrincipal = Effect.gen(function* () {
  const identity = yield* Identity;
  return yield* Option.match(identity.principal, {
    onNone: () => Effect.fail(new Unauthenticated()),
    onSome: Effect.succeed,
  });
});
