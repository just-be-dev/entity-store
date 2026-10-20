import {
  EDGE_HEADER,
  PRINCIPAL_HEADER,
  type AccessIdentity,
  principalFromAccess,
} from "./principal.ts";
import type { AppEnv } from "./stack.ts";

/** `ctx.access`, which workerd sets on requests Cloudflare Access admitted. */
interface AccessContext {
  readonly aud: string;
  getIdentity(): Promise<AccessIdentity | undefined>;
}

/** Access admitted the request; a missing identity just means a service token. */
const identityOf = async (access: AccessContext): Promise<AccessIdentity | undefined> => {
  try {
    return await access.getIdentity();
  } catch {
    return undefined;
  }
};

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    // Under a project path (`/<project>/api/health`), hand the API the path
    // it knows (`/api/health`).
    const base = env.BASE_PATH.replace(/\/$/, "");
    const url = URL.parse(request.url);
    if (url === null) {
      return new Response("Bad request URL", { status: 400 });
    }
    if (base !== "" && url.pathname.startsWith(`${base}/`)) {
      url.pathname = url.pathname.slice(base.length);
    }

    // Never pass on a client's copy of the headers the API trusts.
    const headers = new Headers(request.headers);
    headers.delete(PRINCIPAL_HEADER);
    headers.delete(EDGE_HEADER);
    const access = (ctx as ExecutionContext & { access?: AccessContext }).access;
    if (access !== undefined) {
      headers.set(PRINCIPAL_HEADER, JSON.stringify(principalFromAccess(await identityOf(access))));
      headers.set(EDGE_HEADER, env.EDGE_SECRET);
    }
    return env.API.fetch(new Request(url, new Request(request, { headers })));
  },
};
