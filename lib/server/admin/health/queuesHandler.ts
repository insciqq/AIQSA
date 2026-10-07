import type { AdminHealthQueuesErrorResponse, AdminHealthQueuesResponse } from "../../../contracts/adminHealthQueues";
import type { RequestAuthResolver } from "../../auth/requestAuth";
import { logEvent } from "../../observability";
import { databaseFailureCode } from "../../observability/databaseFailure";
import type { AdminHealthQueuesService } from "./queues";

function json(body: AdminHealthQueuesResponse | AdminHealthQueuesErrorResponse, status = 200): Response {
  const response = Response.json(body, { status });
  response.headers.set("cache-control", "private, no-store, max-age=0");
  response.headers.set("vary", "Cookie");
  return response;
}

/** GET /api/admin/health/queues: the background queue snapshot for active administrators. */
export function createAdminHealthQueuesHandler(input: Readonly<{ resolveAuth: RequestAuthResolver; service: AdminHealthQueuesService }>) {
  return async function GET(request: Request): Promise<Response> {
    const session = await input.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (session.user.status !== "active" || session.user.role !== "admin") return json({ error: "forbidden" }, 403);
    try {
      return json({ queues: await input.service.read() });
    } catch (error) {
      logEvent("service_operation", { subsystem: "admin", stage: "read", outcome: "failed",
        code: "admin_health_failed", prisma_code: databaseFailureCode(error) });
      return json({ error: "admin_health_failed" }, 503);
    }
  };
}
