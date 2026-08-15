import {
  ADMIN_PROVIDER_CUSTOM_AUTHENTICATION_MODES,
  type AdminProviderCustomAuthenticationMode,
  type AdminProviderCustomDiscoveryResult
} from "../../../contracts/adminProviderCustomSetup";
import {
  ADMIN_PROVIDER_RESPONSE_TIMEOUT_MAX_SECONDS,
  ADMIN_PROVIDER_RESPONSE_TIMEOUT_MIN_SECONDS
} from "../../../contracts/adminProviders";
import type { RequestAuthResolver } from "../../auth/requestAuth";
import {
  readJsonBodyOrNull,
  requestBodyErrorResponse
} from "../../http/requestBody";
import { normalizeProviderCredentialSecret } from "../../providers/credentialSecrets";
import { normalizeProviderConnectionConfiguration } from "../../providers/providerConfiguration";
import {
  AdminProviderCredentialTestError,
  type AdminProviderCredentialTester
} from "./credentialTester";

export type AdminProviderCustomDiscoveryHandlerDeps = Readonly<{
  now?: () => Date;
  resolveAuth: RequestAuthResolver;
  tester: AdminProviderCredentialTester;
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

export function createAdminProviderCustomDiscoveryHandler(
  deps: AdminProviderCustomDiscoveryHandlerDeps
) {
  const now = deps.now ?? (() => new Date());

  return async function POST(request: Request): Promise<Response> {
    if (!hasJsonContentType(request)) return errorJson("json_required", 415);
    const session = await deps.resolveAuth(request);
    if (!session) return errorJson("unauthorized", 401);
    if (session.user.status !== "active" || session.user.role !== "admin") {
      return errorJson("forbidden", 403);
    }

    const body = await readJsonBodyOrNull(request, "json");
    const bodyError = requestBodyErrorResponse(body);
    if (bodyError) return bodyError;
    if (!isRecord(body)) return errorJson("provider_configuration_invalid", 400);
    const allowedKeys = new Set([
      "allowPrivateNetwork",
      "apiRoot",
      "authenticationMode",
      "responseTimeoutSeconds",
      "secret"
    ]);
    if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
      return errorJson("provider_configuration_invalid", 400);
    }

    const mode = authenticationMode(body.authenticationMode);
    const apiRoot = boundedText(body.apiRoot, 2_048);
    const rawSecret = body.secret === undefined
      ? undefined
      : boundedText(body.secret, 16_384) ?? null;
    const responseTimeoutSeconds = Number.isSafeInteger(body.responseTimeoutSeconds) &&
          Number(body.responseTimeoutSeconds) >= ADMIN_PROVIDER_RESPONSE_TIMEOUT_MIN_SECONDS &&
          Number(body.responseTimeoutSeconds) <= ADMIN_PROVIDER_RESPONSE_TIMEOUT_MAX_SECONDS
        ? Number(body.responseTimeoutSeconds)
        : null;
    if (
      !mode ||
      !apiRoot ||
      typeof body.allowPrivateNetwork !== "boolean" ||
      responseTimeoutSeconds === null ||
      rawSecret === null ||
      (mode === "bearer" && rawSecret === undefined) ||
      (mode === "none" && rawSecret !== undefined)
    ) {
      return errorJson("provider_configuration_invalid", 400);
    }

    try {
      const connection = normalizeProviderConnectionConfiguration({
        allowPrivateNetwork: body.allowPrivateNetwork,
        apiRoot,
        authenticationMode: mode,
        responseTimeoutMs: responseTimeoutSeconds * 1_000
      });
      const secret = rawSecret === undefined
        ? null
        : normalizeProviderCredentialSecret(rawSecret).trim();
      const outcome = await deps.tester.test({
        connection,
        family: "openai_compatible",
        secret,
        signal: request.signal
      });
      const result: AdminProviderCustomDiscoveryResult = {
        checkedAt: now().toISOString(),
        modelCount: outcome.modelIds.length,
        models: outcome.models ?? outcome.modelIds.map((id) => ({ capabilities: {}, id })),
        source: "models_catalog",
        status: "valid"
      };
      return Response.json(result);
    } catch (error) {
      if (error instanceof AdminProviderCredentialTestError) {
        return errorJson("provider_custom_setup_discovery_failed", 422);
      }
      return errorJson("provider_configuration_invalid", 400);
    }
  };
}
