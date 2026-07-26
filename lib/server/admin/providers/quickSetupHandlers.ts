import {
  ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS,
  type AdminProviderQuickSetupClearRequest,
  type AdminProviderQuickSetupProviderId,
  type AdminProviderQuickSetupRequest,
  type AdminProviderQuickSetupSelection
} from "../../../contracts/adminProviderQuickSetup";
import type { RequestAuthResolver } from "../../auth/requestAuth";
import {
  AdminProviderQuickSetupServiceError,
  type AdminProviderQuickSetupService
} from "./quickSetupService";

export type AdminProviderQuickSetupHandlerDeps = Readonly<{
  resolveAuth: RequestAuthResolver;
  service: AdminProviderQuickSetupService;
}>;

function errorJson(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  return contentType === "application/json" || contentType.endsWith("+json");
}

function boundedText(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.trim() && value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

function provider(value: unknown): AdminProviderQuickSetupProviderId | null {
  return ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS.includes(
    value as AdminProviderQuickSetupProviderId
  ) ? value as AdminProviderQuickSetupProviderId : null;
}

function selection(value: unknown): AdminProviderQuickSetupSelection | null | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "candidateId" && key !== "policyVersion")) {
    return null;
  }
  const candidateId = boundedText(record.candidateId, 64);
  if (!candidateId || !Number.isSafeInteger(record.policyVersion) || Number(record.policyVersion) < 1) {
    return null;
  }
  return { candidateId, policyVersion: Number(record.policyVersion) };
}

async function requireAdmin(request: Request, deps: AdminProviderQuickSetupHandlerDeps) {
  const session = await deps.resolveAuth(request);
  if (!session) return { actor: null, response: errorJson("unauthorized", 401) };
  if (session.user.status !== "active" || session.user.role !== "admin") {
    return { actor: null, response: errorJson("forbidden", 403) };
  }
  return {
    actor: { sessionId: session.id, userId: session.userId },
    response: null
  };
}

function serviceError(error: AdminProviderQuickSetupServiceError): Response {
  const status = error.code === "provider_draft_stale" ||
    error.code === "provider_quick_setup_advanced_required"
    ? 409
    : error.code === "provider_quick_setup_selection_invalid"
      ? 400
      : 422;
  return errorJson(error.code, status);
}

async function safely(operation: () => Promise<Response>): Promise<Response> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AdminProviderQuickSetupServiceError) return serviceError(error);
    console.error("provider_quick_setup_failed");
    return errorJson("provider_quick_setup_failed", 500);
  }
}

export function createAdminProviderQuickSetupSnapshotHandler(
  deps: AdminProviderQuickSetupHandlerDeps
) {
  return async function GET(request: Request): Promise<Response> {
    const auth = await requireAdmin(request, deps);
    if (auth.response || !auth.actor) return auth.response ?? errorJson("unauthorized", 401);
    return safely(async () => Response.json(await deps.service.getSnapshot(auth.actor)));
  };
}

export function createAdminProviderQuickSetupMutationHandler(
  deps: AdminProviderQuickSetupHandlerDeps
) {
  return async function POST(request: Request): Promise<Response> {
    if (!hasJsonContentType(request)) return errorJson("json_required", 415);
    const auth = await requireAdmin(request, deps);
    if (auth.response || !auth.actor) return auth.response ?? errorJson("unauthorized", 401);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorJson("provider_configuration_invalid", 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return errorJson("provider_configuration_invalid", 400);
    }
    const record = body as Record<string, unknown>;
    const allowedKeys = new Set(["expectedState", "provider", "secret", "selectedModel"]);
    if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
      return errorJson("provider_configuration_invalid", 400);
    }
    const providerId = provider(record.provider);
    const secret = boundedText(record.secret, 16_384);
    const expectedState = boundedText(record.expectedState, 128);
    const selectedModel = selection(record.selectedModel);
    if (!providerId || !secret || !expectedState || selectedModel === null) {
      return errorJson(
        selectedModel === null
          ? "provider_quick_setup_selection_invalid"
          : "provider_configuration_invalid",
        400
      );
    }
    const quickSetupRequest: AdminProviderQuickSetupRequest = {
      expectedState,
      provider: providerId,
      secret,
      ...(selectedModel ? { selectedModel } : {})
    };
    return safely(async () => Response.json(await deps.service.setup({
      actor: auth.actor,
      request: quickSetupRequest,
      signal: request.signal
    })));
  };
}

export function createAdminProviderQuickSetupClearHandler(
  deps: AdminProviderQuickSetupHandlerDeps
) {
  return async function DELETE(request: Request): Promise<Response> {
    if (!hasJsonContentType(request)) return errorJson("json_required", 415);
    const auth = await requireAdmin(request, deps);
    if (auth.response || !auth.actor) return auth.response ?? errorJson("unauthorized", 401);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorJson("provider_configuration_invalid", 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return errorJson("provider_configuration_invalid", 400);
    }
    const record = body as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== "expectedState" && key !== "provider")) {
      return errorJson("provider_configuration_invalid", 400);
    }
    const providerId = provider(record.provider);
    const expectedState = boundedText(record.expectedState, 128);
    if (!providerId || !expectedState) {
      return errorJson("provider_configuration_invalid", 400);
    }
    const clearRequest: AdminProviderQuickSetupClearRequest = {
      expectedState,
      provider: providerId
    };
    return safely(async () => Response.json(await deps.service.clearAssignment({
      actor: auth.actor,
      request: clearRequest
    })));
  };
}
