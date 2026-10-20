import type { AppEnv } from "./stack.ts";

export default {
  fetch(request: Request, env: AppEnv): Promise<Response> {
    // Under a project path (`/<project>/api/health`), hand the API the path
    // it knows (`/api/health`). Headers, including the Access token the API
    // verifies, pass through unchanged.
    const base = env.BASE_PATH.replace(/\/$/, "");
    const url = URL.parse(request.url);
    if (url === null) {
      return Promise.resolve(new Response("Bad request URL", { status: 400 }));
    }
    if (base !== "" && url.pathname.startsWith(`${base}/`)) {
      url.pathname = url.pathname.slice(base.length);
      return env.API.fetch(new Request(url, request));
    }
    return env.API.fetch(request);
  },
};
