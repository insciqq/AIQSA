import type {
  AdminAttentionErrorResponse,
  AdminAttentionResponse
} from "../../../contracts/adminAttention";
import type { RequestAuthResolver } from "../../auth/requestAuth";
import type { AdminAttentionService } from "./service";

const PRIVATE_CACHE_CONTROL = "private, no-store, max-age=0";

function json(body: AdminAttentionResponse | AdminAttentionErrorResponse, status = 200): Response {
  const response = Response.json(body, { status });
  response.headers.set("cache-control", PRIVATE_CACHE_CONTROL);
  response.headers.set("vary", "Cookie");
  return response;
}

export function createAdminAttentionHandler(input: Readonly<{
  resolveAuth: RequestAuthResolver;
  service: AdminAttentionService;
}>) {
  return async function GET(request: Request): Promise<Response> {
    const session = await input.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (session.user.status !== "active" || session.user.role !== "admin") {
      return json({ error: "forbidden" }, 403);
    }
    try {
      return json({ attention: await input.service.list(session.userId) });
    } catch {
      console.error("admin_attention_failed");
      return json({ error: "admin_attention_failed" }, 500);
    }
  };
}
