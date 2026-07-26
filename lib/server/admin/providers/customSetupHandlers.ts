import {
  ADMIN_PROVIDER_CUSTOM_AUTHENTICATION_MODES,
  type AdminProviderCustomAuthenticationMode,
  type AdminProviderCustomSetupRequest
} from "../../../contracts/adminProviderCustomSetup";
import type { AdminProviderModelCapabilities } from "../../../contracts/adminProviders";
import type { RequestAuthResolver } from "../../auth/requestAuth";
import { ProviderConfigurationError } from "../../providers/providerConfiguration";
import {
  AdminProviderCustomSetupServiceError,
  type AdminProviderCustomSetupService
} from "./customSetupService";

export type AdminProviderCustomSetupHandlerDeps = Readonly<{
  resolveAuth: RequestAuthResolver;
  service: AdminProviderCustomSetupService;
}>;

function errorJson(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase() ?? "";
  return contentType === "application/json" || contentType.endsWith("+json");
}

function boundedText(value: unknown, maxLength: number): string | null {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

function authenticationMode(
  value: unknown
): AdminProviderCustomAuthenticationMode | null {
  return ADMIN_PROVIDER_CUSTOM_AUTHENTICATION_MODES.includes(
    value as AdminProviderCustomAuthenticationMode
  ) ? value as AdminProviderCustomAuthenticationMode : null;
}

async function requireAdmin(
  request: Request,
  deps: AdminProviderCustomSetupHandlerDeps
) {
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

function serviceError(error: AdminProviderCustomSetupServiceError): Response {
  const status = error.code === "provider_custom_setup_stale"
    ? 409
    : error.code === "provider_custom_setup_test_failed"
      ? 422
      : 409;
  return errorJson(error.code, status);
}

function configurationError(error: unknown): boolean {
  return error instanceof ProviderConfigurationError || (
    error instanceof Error && (
      error.message === "provider_credential_secret_invalid" ||
      error.message === "provider_custom_setup_authentication_invalid" ||
      error.message === "provider_custom_setup_name_invalid"
    )
  );
}

async function safely(operation: () => Promise<Response>): Promise<Response> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AdminProviderCustomSetupServiceError) {
      return serviceError(error);
    }
    if (configurationError(error)) {
      return errorJson("provider_configuration_invalid", 400);
    }
    console.error("provider_custom_setup_failed");
    return errorJson("provider_custom_setup_failed", 500);
  }
}

export function createAdminProviderCustomSetupHandler(
  deps: AdminProviderCustomSetupHandlerDeps
) {
  return async function POST(request: Request): Promise<Response> {
    if (!hasJsonContentType(request)) return errorJson("json_required", 415);
    const auth = await requireAdmin(request, deps);
    if (auth.response || !auth.actor) {
      return auth.response ?? errorJson("unauthorized", 401);
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorJson("provider_configuration_invalid", 400);
    }
    if (!isRecord(body)) return errorJson("provider_configuration_invalid", 400);
    const allowedKeys = new Set([
      "allowPrivateNetwork",
      "apiRoot",
      "authenticationMode",
      "capabilities",
      "confirmPaidRequest",
      "connectionDisplayName",
      "defaultParams",
      "modelDisplayName",
      "modelId",
      "secret"
    ]);
    if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
      return errorJson("provider_configuration_invalid", 400);
    }
    const mode = authenticationMode(body.authenticationMode);
    const apiRoot = boundedText(body.apiRoot, 2_048);
    const modelId = boundedText(body.modelId, 256);
    const connectionDisplayName = body.connectionDisplayName === undefined
      ? undefined
      : boundedText(body.connectionDisplayName, 160) ?? null;
    const modelDisplayName = body.modelDisplayName === undefined
      ? undefined
      : boundedText(body.modelDisplayName, 160) ?? null;
    const secret = body.secret === undefined
      ? undefined
      : boundedText(body.secret, 16_384) ?? null;
    if (
      !mode ||
      !apiRoot ||
      !modelId ||
      typeof body.allowPrivateNetwork !== "boolean" ||
      body.confirmPaidRequest !== true ||
      connectionDisplayName === null ||
      modelDisplayName === null ||
      secret === null ||
      (body.capabilities !== undefined && !isRecord(body.capabilities)) ||
      (body.defaultParams !== undefined && !isRecord(body.defaultParams)) ||
      (mode === "bearer" && secret === undefined) ||
      (mode === "none" && secret !== undefined)
    ) {
      return errorJson("provider_configuration_invalid", 400);
    }
    const setupRequest: AdminProviderCustomSetupRequest = {
      allowPrivateNetwork: body.allowPrivateNetwork,
      apiRoot,
      authenticationMode: mode,
      ...(body.capabilities === undefined
        ? {}
        : { capabilities: body.capabilities as AdminProviderModelCapabilities }),
      confirmPaidRequest: true,
      ...(connectionDisplayName === undefined ? {} : { connectionDisplayName }),
      ...(body.defaultParams === undefined
        ? {}
        : { defaultParams: body.defaultParams }),
      ...(modelDisplayName === undefined ? {} : { modelDisplayName }),
      modelId,
      ...(secret === undefined ? {} : { secret })
    };
    return safely(async () => Response.json(await deps.service.setup({
      actor: auth.actor,
      request: setupRequest,
      signal: request.signal
    })));
  };
}
