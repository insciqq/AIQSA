import type { RequestAuthResolver } from "../../auth/requestAuth";
import {
  readJsonBodyOrNull,
  requestBodyErrorResponse
} from "../../http/requestBody";
import {
  AdminRunProfileServiceError,
  type AdminRunProfileService
} from "./service";

export type AdminRunProfileHandlerDeps = Readonly<{
  resolveAuth: RequestAuthResolver;
  service: AdminRunProfileService;
}>;

function errorJson(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  return contentType === "application/json" || contentType.endsWith("+json");
}

async function requireAdmin(request: Request, deps: AdminRunProfileHandlerDeps) {
  const session = await deps.resolveAuth(request);
  if (!session) return { response: errorJson("unauthorized", 401), userId: null };
  if (session.user.status !== "active" || session.user.role !== "admin") {
    return { response: errorJson("forbidden", 403), userId: null };
  }
  return { response: null, userId: session.userId };
}

function serviceError(error: AdminRunProfileServiceError): Response {
  const status = error.code === "run_profile_stale"
    ? 409
    : error.code === "run_profile_target_invalid"
      ? 422
      : 400;
  return errorJson(error.code, status);
}

async function safely(operation: () => Promise<Response>): Promise<Response> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AdminRunProfileServiceError) return serviceError(error);
    console.error("run_profile_admin_action_failed");
    return errorJson("run_profile_admin_action_failed", 500);
  }
}

export function createAdminRunProfileCatalogHandler(deps: AdminRunProfileHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const auth = await requireAdmin(request, deps);
    if (auth.response) return auth.response;
    return safely(async () => Response.json(await deps.service.getCatalog()));
  };
}

export function createAdminRunProfileUpdateHandler(deps: AdminRunProfileHandlerDeps) {
  return async function PUT(request: Request): Promise<Response> {
    if (!hasJsonContentType(request)) return errorJson("json_required", 415);
    const auth = await requireAdmin(request, deps);
    if (auth.response || !auth.userId) return auth.response ?? errorJson("unauthorized", 401);
    const body = await readJsonBodyOrNull(request, "json");
    const bodyError = requestBodyErrorResponse(body);
    if (bodyError) return bodyError;
    if (body === null) return errorJson("run_profile_configuration_invalid", 400);
    const profiles = body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).profiles
      : null;
    return safely(async () => Response.json(await deps.service.update({
      profiles,
      updatedByUserId: auth.userId as string
    })));
  };
}
