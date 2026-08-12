import { decodeAdminMemoryEgressAcknowledgeInput } from "../../../contracts/adminMemory";
import type { RequestAuthResolver } from "../../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../../http/requestBody";
import {
  AdminMemoryEgressServiceError,
  type createAdminMemoryEgressService
} from "./egressService";
import type { MemoryHealthService } from "../../memory/health/service";
import { unavailableAdminMemoryHealth } from "../../../contracts/memoryHealth";

type Service = ReturnType<typeof createAdminMemoryEgressService>;

const PRIVATE_CACHE_CONTROL = "private, no-store, max-age=0";

function json(body: unknown, status = 200): Response {
  const response = Response.json(body, { status });
  response.headers.set("cache-control", PRIVATE_CACHE_CONTROL);
  response.headers.set("vary", "Cookie");
  return response;
}

async function requireAdmin(request: Request, resolveAuth: RequestAuthResolver) {
  const session = await resolveAuth(request);
  if (!session) return { error: json({ error: "unauthorized" }, 401), session: null };
  if (session.user.status !== "active" || session.user.role !== "admin") {
    return { error: json({ error: "forbidden" }, 403), session: null };
  }
  return { error: null, session };
}

function serviceFailure(error: unknown): Response {
  if (error instanceof AdminMemoryEgressServiceError) {
    const status = error.code === "memory_admin_egress_policy_missing"
      ? 500
      : error.code === "memory_admin_egress_per_user_mode"
        ? 403
        : 409;
    return json({ error: error.code }, status);
  }
  console.error("memory_admin_egress_action_failed");
  return json({ error: "memory_admin_egress_action_failed" }, 500);
}

function isJsonContentType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

async function healthProjection(
  service: MemoryHealthService,
  adminUserId: string,
  egressReviewRequired: boolean
) {
  try {
    return await service.admin(adminUserId, { egressReviewRequired });
  } catch {
    console.error("memory_admin_health_read_failed");
    return unavailableAdminMemoryHealth("EN");
  }
}

export function createAdminMemoryEgressHandlers(input: Readonly<{
  healthService: MemoryHealthService;
  resolveAuth: RequestAuthResolver;
  service: Service;
}>) {
  return Object.freeze({
    async GET(request: Request): Promise<Response> {
      const auth = await requireAdmin(request, input.resolveAuth);
      if (auth.error || !auth.session) return auth.error!;
      try {
        const memoryEgress = await input.service.get();
        return json({
          memoryEgress,
          memoryHealth: await healthProjection(
            input.healthService,
            auth.session.userId,
            memoryEgress.reviewRequired
          )
        });
      } catch (error) {
        return serviceFailure(error);
      }
    },

    async PATCH(request: Request): Promise<Response> {
      if (!isJsonContentType(request.headers.get("content-type"))) {
        return json({ error: "json_required" }, 415);
      }
      const auth = await requireAdmin(request, input.resolveAuth);
      if (auth.error || !auth.session) return auth.error!;
      const value = await readJsonBodyOrNull(request, "json");
      const bodyError = requestBodyErrorResponse(value);
      if (bodyError) {
        bodyError.headers.set("cache-control", PRIVATE_CACHE_CONTROL);
        bodyError.headers.set("vary", "Cookie");
        return bodyError;
      }
      const decoded = decodeAdminMemoryEgressAcknowledgeInput(value);
      if (!decoded) return json({ error: "memory_admin_egress_input_invalid" }, 400);
      try {
        const memoryEgress = await input.service.acknowledge(
          auth.session.userId,
          decoded
        );
        return json({
          memoryEgress,
          memoryHealth: await healthProjection(
            input.healthService,
            auth.session.userId,
            memoryEgress.reviewRequired
          )
        });
      } catch (error) {
        return serviceFailure(error);
      }
    }
  });
}
