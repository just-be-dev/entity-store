import { forwardToHub, isHubPath } from "./hub.ts";

/**
 * What the edge reads from the App's env (`AppEnv`, checked in hub.test.ts): the API, and
 * agents' bindings and the Access settings for the shell (hub.ts).
 */
export type EdgeEnv = Readonly<Record<string, unknown>> &
  Readonly<{ API: { readonly fetch: (request: Request) => Promise<Response> } }>;

export default {
  fetch(request: Request, env: EdgeEnv): Promise<Response> {
    // The hub shell's `/_hub/*` goes to the agents project (hub.ts).
    const url = URL.parse(request.url);
    if (url !== null && isHubPath(url)) return forwardToHub(request, url, env);
    // Headers, including the Access token the API verifies, pass through unchanged.
    return env.API.fetch(request);
  },
};
