import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Who is making a request, as verified by the platform (Cloudflare Access in
 * production, a simulated user in local dev). A missing principal means the
 * request is unauthenticated.
 */
export const Principal = Schema.Union([
  /** A person who signed in. */
  Schema.TaggedStruct("User", { email: Schema.String }),
  /** A machine client using an Access service token (e.g. an agent). */
  Schema.TaggedStruct("ServiceToken", { name: Schema.String }),
]);
export type Principal = typeof Principal.Type;

/** The request's verified principal. Provided per request by the platform. */
export class Identity extends Context.Service<
  Identity,
  { readonly principal: Option.Option<Principal> }
>()("entity-store/Identity") {
  static readonly anonymous = Layer.succeed(Identity, { principal: Option.none() });
  static readonly as = (principal: Principal) =>
    Layer.succeed(Identity, { principal: Option.some(principal) });
}

/** A short label for logs and audit fields. */
export const describePrincipal = (principal: Principal): string =>
  principal._tag === "User" ? principal.email : `service:${principal.name}`;
