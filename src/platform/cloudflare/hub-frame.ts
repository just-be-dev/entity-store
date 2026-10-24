/**
 * The hub that frames this app (hub-frame-spike.md §3, §4.8; hub-frame-rollout.md §1.1, §1.7):
 * hub.just-be.dev serves it under `/entities[@<stage>]/`, proxies its requests with hub prod's
 * Access service token (`PlatformToken`), and names the person in `x-hub-identity`, signed with hub
 * prod's `IdentityKey`. The app reads the token's ids and the public key from hub prod's Alchemy
 * state by typed ref, at plan time.
 *
 * Every stage, prod and previews, trusts hub prod and only hub prod, so a hub preview never vouches
 * for anyone here. Only the stack's modules (access.ts, api.ts, stack.ts) import this, and only on
 * deployed stages: `alchemy dev` declares no hub refs. The edge never imports it (hub.test.ts).
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";

/** The hub's Alchemy stack name. */
export const HUB_STACK = "hub";

/** The hub stage every stage of this app trusts. */
export const TRUSTED_HUB_STAGE = "prod";

/** This app's id in the hub's frame registry: its path segment and its identity audience. */
export const HUB_APP_ID = "entities";

/** Hub prod's Access service token. */
export const hubToken = () =>
  Cloudflare.Access.ServiceToken.ref("PlatformToken", {
    stack: HUB_STACK,
    stage: TRUSTED_HUB_STAGE,
  });

/** Hub prod's identity signing key; the app reads only its public key. */
export const hubKey = () =>
  Alchemy.KeyPair.ref("IdentityKey", { stack: HUB_STACK, stage: TRUSTED_HUB_STAGE });

/** The audience the hub's identity tokens name for this stage: `entities@prod`, `entities@b-…`. */
export const hubAudience = (stage: string): string => `${HUB_APP_ID}@${stage}`;

/** Where this stage lives on the hub: `/entities` for prod, `/entities@<stage>` for a preview. */
export const hubFramePrefix = (stage: string): string =>
  stage === "prod" ? `/${HUB_APP_ID}` : `/${HUB_APP_ID}@${stage}`;
