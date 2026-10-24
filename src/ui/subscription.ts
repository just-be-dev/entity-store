/** Keeps the hub shell's sidebar in step with the app. */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Subscription } from "foldkit";
import { HubNav, hubNavOf, publishHubNav } from "./hub-nav.ts";
import type { Message, Model } from "./main.ts";

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  /** Publishes the nav whenever it changes; the dependency compares it structurally. */
  hubNav: entry(
    { nav: HubNav },
    {
      modelToDependencies: (model) => ({ nav: hubNavOf(model) }),
      dependenciesToStream: ({ nav }) =>
        Stream.fromEffect(Effect.sync(() => publishHubNav(nav))).pipe(Stream.drain),
    },
  ),
}));
