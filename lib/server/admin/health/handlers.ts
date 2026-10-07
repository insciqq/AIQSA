import {
  defaultAdminHealthRange,
  isAdminHealthRange,
  parseAdminHealthIncidentFilters,
  type AdminHealthErrorResponse,
  type AdminHealthIncidentsResponse,
  type AdminHealthResponse
} from "../../../contracts/adminHealth";
import type { RequestAuthResolver } from "../../auth/requestAuth";
import { logEvent } from "../../observability";
import { databaseFailureCode } from "../../observability/databaseFailure";
import { TelemetryQueryError } from "../../telemetry/store";
import type { AdminHealthService } from "./service";

const PRIVATE_CACHE_CONTROL = "private, no-store, max-age=0";

function json(body: AdminHealthResponse | AdminHealthIncidentsResponse | AdminHealthErrorResponse, status = 200): Response {
  const response = Response.json(body, { status });
  response.headers.set("cache-control", PRIVATE_CACHE_CONTROL);
  response.headers.set("vary", "Cookie");
  return response;
}

type HandlerInput = Readonly<{ resolveAuth: RequestAuthResolver; service: AdminHealthService }>;

async function adminDenial(request: Request, resolveAuth: RequestAuthResolver): Promise<Response | null> {
  const session = await resolveAuth(request);
  if (!session) return json({ error: "unauthorized" }, 401);
  if (session.user.status !== "active" || session.user.role !== "admin") return json({ error: "forbidden" }, 403);
  return null;
}

function failure(error: unknown): Response {
  if (error instanceof TelemetryQueryError) return json({ error: "admin_health_query_invalid" }, 400);
  logEvent("service_operation", { subsystem: "admin", stage: "read", outcome: "failed",
    code: "admin_health_failed", prisma_code: databaseFailureCode(error) });
  return json({ error: "admin_health_failed" }, 503);
}

/** GET /api/admin/health?range=24h|7d|30d */
export function createAdminHealthHandler(input: HandlerInput) {
  return async function GET(request: Request): Promise<Response> {
    const denial = await adminDenial(request, input.resolveAuth);
    if (denial) return denial;
    const values = new URL(request.url).searchParams.getAll("range");
    const range = values.length === 0 ? defaultAdminHealthRange : values.length === 1 ? values[0] : null;
    if (!isAdminHealthRange(range)) return json({ error: "admin_health_query_invalid" }, 400);
    try {
      return json({ health: await input.service.read(range) });
    } catch (error) {
      return failure(error);
    }
  };
}

/** GET /api/admin/health/incidents?range&category&event&code&level&q&cursor */
export function createAdminHealthIncidentsHandler(input: HandlerInput) {
  return async function GET(request: Request): Promise<Response> {
    const denial = await adminDenial(request, input.resolveAuth);
    if (denial) return denial;
    const filters = parseAdminHealthIncidentFilters(new URL(request.url).searchParams);
    if (!filters) return json({ error: "admin_health_query_invalid" }, 400);
    try {
      return json(await input.service.incidents(filters));
    } catch (error) {
      return failure(error);
    }
  };
}
