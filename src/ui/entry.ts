import { Runtime } from "foldkit";
import { followWithinBase } from "./basePath.ts";
import { init, Message, Model, update, view } from "./main.ts";
import { subscriptions } from "./subscription.ts";
import "@fontsource-variable/inter";
import "@fontsource/ibm-plex-mono/400.css";
import "./styles.css";

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  subscriptions,
  container: document.getElementById("root"),
  routing: {
    onUrlRequest: (request) => Message.ClickedLink({ request: followWithinBase(request) }),
    onUrlChange: (url) => Message.ChangedUrl({ url }),
  },
  devTools: { Message },
});

Runtime.run(application);
