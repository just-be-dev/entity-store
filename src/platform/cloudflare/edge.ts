import type { AppEnv } from "./stack.ts";

export default {
  fetch(request: Request, env: AppEnv): Promise<Response> {
    // Headers, including the Access token the API verifies, pass through unchanged.
    return env.API.fetch(request);
  },
};
