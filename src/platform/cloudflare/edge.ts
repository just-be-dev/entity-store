import { forwardToHub, isHubPath } from "./hub.ts";
import type { AppEnv } from "./stack.ts";

export default {
  fetch(request: Request, env: AppEnv): Promise<Response> {
    // The hub shell's `/_hub/*` goes to the agents project (hub.ts).
    const url = URL.parse(request.url);
    if (url !== null && isHubPath(url)) return forwardToHub(request, url, env);
    // Headers, including the Access token the API verifies, pass through unchanged.
    return env.API.fetch(request);
  },
};
