import type {
  AdminAttentionErrorResponse,
  AdminAttentionResponse,
  AdminAttentionSummaryResponse
} from "../../../contracts/adminAttention";
import type { RequestAuthResolver } from "../../auth/requestAuth";
import { logEvent } from "../../observability";
import { databaseFailureCode } from "../../observability/databaseFailure";
import type { AdminAttentionService } from "./service";
import type { AdminAttentionSummaryService } from "./summary";

const PRIVATE_CACHE_CONTROL = "private, no-store, max-age=0";

function json(
  body: AdminAttentionResponse | AdminAttentionSummaryResponse | AdminAttentionErrorResponse,
  status = 200
): Response {
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
    } catch (error) {
      logEvent("service_operation", { subsystem: "admin", stage: "read", outcome: "failed",
        code: "admin_attention_failed", prisma_code: databaseFailureCode(error) });
      return json({ error: "admin_attention_failed" }, 500);
    }
  };
}

/** The app-wide badge counts; the same administrator gate as the full list. */
export function createAdminAttentionSummaryHandler(input: Readonly<{
  resolveAuth: RequestAuthResolver;
  service: AdminAttentionSummaryService;
}>) {
  return async function GET(request: Request): Promise<Response> {
    const session = await input.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (session.user.status !== "active" || session.user.role !== "admin") {
      return json({ error: "forbidden" }, 403);
    }
    try {
      return json({ summary: await input.service.read() });
    } catch (error) {
      logEvent("service_operation", { subsystem: "admin", stage: "read", outcome: "failed",
        code: "admin_attention_failed", prisma_code: databaseFailureCode(error) });
      return json({ error: "admin_attention_failed" }, 500);
    }
  };
}
