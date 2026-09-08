import { setupProgressResponse } from "./setupProgressResponse";
import {
  ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS,
  type AdminProviderQuickSetupConnectionOverrides,
  type AdminProviderQuickSetupProviderId,
  type AdminProviderQuickSetupRequest,
  type AdminProviderQuickSetupSelection
} from "../../../contracts/adminProviderQuickSetup";
import {
  ADMIN_PROVIDER_RESPONSE_TIMEOUT_MAX_SECONDS,
  ADMIN_PROVIDER_RESPONSE_TIMEOUT_MIN_SECONDS
} from "../../../contracts/adminProviders";
import type { RequestAuthResolver } from "../../auth/requestAuth";
import {
  readJsonBodyOrNull,
  requestBodyErrorResponse
} from "../../http/requestBody";
import { ProviderConfigurationError } from "../../providers/providerConfiguration";
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

/** Endpoint overrides for a separate connection; `null` marks an invalid shape. */
function overrides(value: unknown): AdminProviderQuickSetupConnectionOverrides | null | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const allowed = new Set(["allowPrivateNetwork", "apiRoot", "responseTimeoutSeconds"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return null;
  const apiRoot = boundedText(record.apiRoot, 2_048);
  const allowPrivateNetwork = record.allowPrivateNetwork;
  const timeout = record.responseTimeoutSeconds;
  if (
    !apiRoot ||
    typeof allowPrivateNetwork !== "boolean" ||
    typeof timeout !== "number" ||
    !Number.isSafeInteger(timeout) ||
    timeout < ADMIN_PROVIDER_RESPONSE_TIMEOUT_MIN_SECONDS ||
    timeout > ADMIN_PROVIDER_RESPONSE_TIMEOUT_MAX_SECONDS
  ) {
    return null;
  }
  return { allowPrivateNetwork, apiRoot, responseTimeoutSeconds: timeout };
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
    error.code === "provider_quick_setup_advanced_required" ||
    error.code === "provider_quick_setup_name_taken"
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
    if (error instanceof ProviderConfigurationError) {
      return errorJson("provider_configuration_invalid", 400);
    }
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
    const body = await readJsonBodyOrNull(request, "json");
    const bodyError = requestBodyErrorResponse(body);
    if (bodyError) return bodyError;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return errorJson("provider_configuration_invalid", 400);
    }
    const record = body as Record<string, unknown>;
    const allowedKeys = new Set([
      "configuration",
      "connectionDisplayName",
      "expectedState",
      "provider",
      "secret",
      "selectedModel"
    ]);
    if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
      return errorJson("provider_configuration_invalid", 400);
    }
    const providerId = provider(record.provider);
    const secret = boundedText(record.secret, 16_384);
    const expectedState = boundedText(record.expectedState, 128);
    const selectedModel = selection(record.selectedModel);
    const connectionDisplayName = record.connectionDisplayName === undefined
      ? undefined
      : boundedText(record.connectionDisplayName, 160) ?? null;
    const configuration = overrides(record.configuration);
    if (!providerId || !secret || !expectedState || selectedModel === null ||
      connectionDisplayName === null || configuration === null ||
      (configuration !== undefined && connectionDisplayName === undefined)) {
      return errorJson(
        selectedModel === null
          ? "provider_quick_setup_selection_invalid"
          : "provider_configuration_invalid",
        400
      );
    }
    const quickSetupRequest: AdminProviderQuickSetupRequest = {
      ...(configuration ? { configuration } : {}),
      ...(connectionDisplayName === undefined ? {} : { connectionDisplayName }),
      expectedState,
      provider: providerId,
      secret,
      ...(selectedModel ? { selectedModel } : {})
    };
    return setupProgressResponse(request, (signal, onProgress) => safely(async () =>
      Response.json(await deps.service.setup({
        actor: auth.actor,
        onProgress,
        request: quickSetupRequest,
        signal
      }))));
  };
}
