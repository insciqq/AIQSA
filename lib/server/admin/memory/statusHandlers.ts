import {
  decodeAdminMemoryAdmissionTimeoutInput,
  decodeAdminMemoryRebuildInput
} from "../../../contracts/adminMemory";
import type { RequestAuthResolver } from "../../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../../http/requestBody";
import {
  AdminMemoryStatusServiceError,
  type AdminMemoryStatusService
} from "./statusService";

const PRIVATE_CACHE_CONTROL = "private, no-store, max-age=0";

function json(body: unknown, status = 200): Response {
  const response = Response.json(body, { status });
  response.headers.set("cache-control", PRIVATE_CACHE_CONTROL);
  response.headers.set("vary", "Cookie");
  return response;
}

async function requireAdmin(request: Request, resolveAuth: RequestAuthResolver) {
  const session = await resolveAuth(request);
  if (!session) return { response: json({ error: "unauthorized" }, 401), userId: null };
  if (session.user.status !== "active" || session.user.role !== "admin") {
    return { response: json({ error: "forbidden" }, 403), userId: null };
  }
  return { response: null, userId: session.userId };
}

function isJsonContentType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function failure(error: unknown): Response {
  if (error instanceof AdminMemoryStatusServiceError) {
    return json({ error: error.code }, 409);
  }
  console.error("memory_admin_status_failed");
  return json({ error: "memory_admin_status_failed" }, 500);
}

export function createAdminMemoryStatusHandlers(input: Readonly<{
  resolveAuth: RequestAuthResolver;
  service: AdminMemoryStatusService;
}>) {
  return Object.freeze({
    async GET(request: Request): Promise<Response> {
      const auth = await requireAdmin(request, input.resolveAuth);
      if (auth.response) return auth.response;
      try {
        return json({ memory: await input.service.get() });
      } catch (error) {
        return failure(error);
      }
    },

    async POST(request: Request): Promise<Response> {
      if (!isJsonContentType(request.headers.get("content-type"))) {
        return json({ error: "json_required" }, 415);
      }
      const auth = await requireAdmin(request, input.resolveAuth);
      if (auth.response) return auth.response;
      const value = await readJsonBodyOrNull(request, "json");
      const bodyError = requestBodyErrorResponse(value);
      if (bodyError) {
        bodyError.headers.set("cache-control", PRIVATE_CACHE_CONTROL);
        bodyError.headers.set("vary", "Cookie");
        return bodyError;
      }
      if (!decodeAdminMemoryRebuildInput(value)) {
        return json({ error: "memory_admin_rebuild_input_invalid" }, 400);
      }
      try {
        return json({ memory: await input.service.rebuild() }, 202);
      } catch (error) {
        return failure(error);
      }
    },

    async PUT(request: Request): Promise<Response> {
      if (!isJsonContentType(request.headers.get("content-type"))) {
        return json({ error: "json_required" }, 415);
      }
      const auth = await requireAdmin(request, input.resolveAuth);
      if (auth.response || !auth.userId) return auth.response!;
      const value = await readJsonBodyOrNull(request, "json");
      const bodyError = requestBodyErrorResponse(value);
      if (bodyError) {
        bodyError.headers.set("cache-control", PRIVATE_CACHE_CONTROL);
        bodyError.headers.set("vary", "Cookie");
        return bodyError;
      }
      const decoded = decodeAdminMemoryAdmissionTimeoutInput(value);
      if (!decoded) {
        return json({ error: "memory_admin_timeout_input_invalid" }, 400);
      }
      try {
        return json({
          memory: await input.service.updateAdmissionTimeout({
            expectedVersion: decoded.expectedVersion,
            seconds: decoded.timeoutSeconds,
            userId: auth.userId
          })
        });
      } catch (error) {
        return failure(error);
      }
    }
  });
}
