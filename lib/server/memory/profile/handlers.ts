import type { RequestAuthResolver } from "../../auth/requestAuth";
import {
  MemoryProfileServiceError,
  type MemoryProfileService
} from "./service";

const PRIVATE_CACHE_CONTROL = "private, no-store, max-age=0";

export type MemoryProfileHandlerDependencies = Readonly<{
  resolveAuth: RequestAuthResolver;
  service: MemoryProfileService;
}>;

function json(body: unknown, status = 200): Response {
  const response = Response.json(body, { status });
  response.headers.set("cache-control", PRIVATE_CACHE_CONTROL);
  response.headers.set("vary", "Cookie");
  return response;
}
export function createGetMemoryProfileHandler(deps: MemoryProfileHandlerDependencies) {
  return async function GET(request: Request): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (new URL(request.url).searchParams.size !== 0) {
      return json({ error: "memory_contract_invalid" }, 400);
    }
    try {
      return json(await deps.service.get(session.userId));
    } catch (error) {
      return error instanceof MemoryProfileServiceError
        ? json({ error: error.code }, 500)
        : json({ error: "memory_action_failed" }, 500);
    }
  };
}
