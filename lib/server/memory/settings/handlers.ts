import { decodeMemorySettingsMutation } from "../../../contracts/memory";
import type { RequestAuthResolver } from "../../auth/requestAuth";
import {
  readJsonBodyOrNull,
  requestBodyErrorResponse
} from "../../http/requestBody";
import {
  MemorySettingsServiceError,
  type MemorySettingsService,
  type MemorySettingsServiceErrorCode
} from "./service";

const PRIVATE_CACHE_CONTROL = "private, no-store, max-age=0";

export type MemorySettingsHandlerDeps = Readonly<{
  resolveAuth: RequestAuthResolver;
  service: MemorySettingsService;
}>;

function withPrivateHeaders(response: Response): Response {
  response.headers.set("cache-control", PRIVATE_CACHE_CONTROL);
  response.headers.set("vary", "Cookie");
  return response;
}

function json(body: unknown, status = 200): Response {
  return withPrivateHeaders(Response.json(body, { status }));
}

function serviceErrorStatus(code: MemorySettingsServiceErrorCode): number {
  switch (code) {
    case "memory_contract_invalid":
    case "memory_embedding_unavailable":
      return 400;
    case "memory_egress_admin_owned":
      return 403;
    case "memory_egress_consent_required":
    case "memory_version_stale":
      return 409;
    case "memory_action_failed":
      return 500;
  }
}

function serviceError(error: unknown): Response {
  return error instanceof MemorySettingsServiceError
    ? json({ error: error.code }, serviceErrorStatus(error.code))
    : json({ error: "memory_action_failed" }, 500);
}

function isJsonContentType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

export function createGetMemorySettingsHandler(deps: MemorySettingsHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    try {
      return json(await deps.service.get(session.userId));
    } catch (error) {
      return serviceError(error);
    }
  };
}

export function createPatchMemorySettingsHandler(deps: MemorySettingsHandlerDeps) {
  return async function PATCH(request: Request): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!isJsonContentType(request.headers.get("content-type"))) {
      return json({ error: "memory_contract_invalid" }, 400);
    }

    const body = await readJsonBodyOrNull(request, "json");
    const bodyError = requestBodyErrorResponse(body);
    if (bodyError) return withPrivateHeaders(bodyError);
    const decoded = decodeMemorySettingsMutation(body);
    if (!decoded.ok) return json({ error: decoded.code }, 400);

    try {
      const response = decoded.value.kind === "patch"
        ? await deps.service.patch(session.userId, decoded.value.value)
        : await deps.service.acceptUtilityEgress(
            session.userId,
            decoded.value.value
          );
      return json(response);
    } catch (error) {
      return serviceError(error);
    }
  };
}
