import type { RequestAuthResolver } from "../../auth/requestAuth";
import type { MemoryHealthService } from "./service";

const PRIVATE_CACHE_CONTROL = "private, no-store, max-age=0";

function json(body: unknown, status = 200): Response {
  const response = Response.json(body, { status });
  response.headers.set("cache-control", PRIVATE_CACHE_CONTROL);
  response.headers.set("vary", "Cookie");
  return response;
}

export function createGetMemoryHealthHandler(input: Readonly<{
  resolveAuth: RequestAuthResolver;
  service: MemoryHealthService;
}>) {
  return async function GET(request: Request): Promise<Response> {
    const session = await input.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    try {
      return json({ health: await input.service.user(session.userId) });
    } catch {
      console.error("memory_health_read_failed");
      return json({ error: "memory_health_unavailable" }, 500);
    }
  };
}
