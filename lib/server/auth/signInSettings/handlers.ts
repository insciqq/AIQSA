import type {
  AdminSignInErrorCode,
  AdminSignInErrorResponse,
  AdminSignInMethodResponse,
  AdminSignInPolicyResponse,
  AdminSignInSecretAction,
  AdminSignInTestResponse
} from "@/lib/contracts/adminSignIn";
import type { AuthSignInMethod } from "@/lib/contracts/authSignInMethods";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../../http/requestBody";
import { logEvent } from "../../observability";
import type { AuthenticatedSession, RequestAuthResolver } from "../requestAuth";
import { isAuthSignInMethod } from "./activeSettings";
import type { SignInSettingsFailureCode } from "./repository";
import { normalizeSignInSecretActions } from "./secrets";
import type { SignInSettingsService } from "./service";

export type AdminSignInHandlerDeps = {
  resolveAuth: RequestAuthResolver;
  service: SignInSettingsService;
};

type MethodRouteContext = {
  params: Promise<{ method: string }> | { method: string };
};

const MAX_VERSION = 2_147_483_647;

function errorJson(error: AdminSignInErrorCode, status: number, extra: { affectedIdentities?: number } = {}): Response {
  return Response.json({ error, ...extra } satisfies AdminSignInErrorResponse, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => key in value) && keys.every((key) => required.includes(key) || optional.includes(key));
}

function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  return contentType === "application/json" || contentType.endsWith("+json");
}

function version(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_VERSION ? value as number : null;
}

async function requireAdmin(
  request: Request,
  deps: AdminSignInHandlerDeps
): Promise<{ response: Response; session: null } | { response: null; session: AuthenticatedSession }> {
  const session = await deps.resolveAuth(request);
  if (!session) return { response: errorJson("unauthorized", 401), session: null };
  if (session.user.status !== "active" || session.user.role !== "admin") {
    return { response: errorJson("forbidden", 403), session: null };
  }
  return { response: null, session };
}

/** Admin check, JSON content type and bounded body, in that order. */
async function readAdminJson(
  request: Request,
  deps: AdminSignInHandlerDeps
): Promise<{ body: Record<string, unknown> | null; response: null; session: AuthenticatedSession } | { response: Response }> {
  if (!hasJsonContentType(request)) return { response: errorJson("json_required", 415) };
  const auth = await requireAdmin(request, deps);
  if (!auth.session) return { response: auth.response };
  const value = await readJsonBodyOrNull(request, "json");
  const bodyError = requestBodyErrorResponse(value);
  if (bodyError) return { response: bodyError };
  return { body: isRecord(value) ? value : null, response: null, session: auth.session };
}

function failureResponse(
  failure: { affectedIdentities?: number; code: SignInSettingsFailureCode | "method_unavailable" }
): Response {
  const outcome = failure.code === "invalid_state" || failure.code === "secret_unreadable" ||
    failure.code === "encryption_unavailable" ? "failed" : "skipped";
  logEvent("service_operation", { subsystem: "admin", stage: "write", outcome, code: failure.code });
  switch (failure.code) {
    case "method_unavailable":
      return errorJson("sign_in_method_unavailable", 404);
    case "active_conflict":
      return errorJson("sign_in_active_conflict", 409);
    case "draft_conflict":
      return errorJson("sign_in_draft_conflict", 409);
    case "encryption_unavailable":
      return errorJson("sign_in_encryption_unavailable", 503);
    case "environment_unsupported":
      return errorJson("sign_in_environment_unsupported", 409);
    case "invalid_configuration":
      return errorJson("sign_in_configuration_invalid", 400);
    case "not_configured":
      return errorJson("sign_in_draft_not_configured", 409);
    case "not_tested":
      return errorJson("sign_in_draft_not_tested", 409);
    case "policy_conflict":
      return errorJson("sign_in_policy_conflict", 409);
    case "lockout_risk":
      return errorJson("password_login_lockout_risk", 409);
    case "source_changed":
      return errorJson("sign_in_source_changed", 409, { affectedIdentities: failure.affectedIdentities ?? 0 });
    case "invalid_state":
    case "secret_unreadable":
      return errorJson("sign_in_state_invalid", 409);
  }
}

async function routeMethod(context: MethodRouteContext): Promise<AuthSignInMethod | null> {
  const { method } = await context.params;
  return isAuthSignInMethod(method) ? method : null;
}

export function createAdminSignInReadHandler(deps: AdminSignInHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const auth = await requireAdmin(request, deps);
    if (!auth.session) return auth.response;
    return Response.json(await deps.service.overview({ sessionId: auth.session.id }));
  };
}

/** `PUT` saves the method's draft; `POST` runs `test`, `activate` or `disable`. */
export function createAdminSignInMethodHandlers(deps: AdminSignInHandlerDeps) {
  async function PUT(request: Request, context: MethodRouteContext): Promise<Response> {
    const read = await readAdminJson(request, deps);
    if (read.response) return read.response;
    const method = await routeMethod(context);
    if (!method || !deps.service.isAvailable(method)) return errorJson("sign_in_method_unavailable", 404);
    const body = read.body;
    const expectedDraftVersion = body ? version(body.expectedDraftVersion) : null;
    if (!body || !hasOnlyKeys(body, ["config", "expectedDraftVersion"], ["secretActions"]) || expectedDraftVersion === null) {
      return errorJson("sign_in_configuration_invalid", 400);
    }
    let secretActions: Record<string, AdminSignInSecretAction>;
    try {
      secretActions = normalizeSignInSecretActions(method, body.secretActions);
    } catch {
      return errorJson("sign_in_configuration_invalid", 400);
    }
    const result = await deps.service.saveDraft({
      actorUserId: read.session.userId,
      config: body.config,
      expectedDraftVersion,
      method,
      secretActions
    });
    return result.ok
      ? Response.json({ method: result.value } satisfies AdminSignInMethodResponse)
      : failureResponse(result);
  }

  async function POST(request: Request, context: MethodRouteContext): Promise<Response> {
    const read = await readAdminJson(request, deps);
    if (read.response) return read.response;
    const method = await routeMethod(context);
    if (!method || !deps.service.isAvailable(method)) return errorJson("sign_in_method_unavailable", 404);
    const body = read.body;
    if (!body || typeof body.action !== "string") return errorJson("sign_in_configuration_invalid", 400);

    if (body.action === "test") {
      const expectedDraftVersion = version(body.expectedDraftVersion);
      if (!hasOnlyKeys(body, ["action", "expectedDraftVersion"]) || expectedDraftVersion === null) {
        return errorJson("sign_in_configuration_invalid", 400);
      }
      const result = await deps.service.test({ expectedDraftVersion, method });
      return result.ok
        ? Response.json({ method: result.value.method, test: result.value.test } satisfies AdminSignInTestResponse)
        : failureResponse(result);
    }

    if (body.action === "activate") {
      const expectedDraftVersion = version(body.expectedDraftVersion);
      const expectedActiveVersion = version(body.expectedActiveVersion);
      if (
        !hasOnlyKeys(body, ["action", "expectedActiveVersion", "expectedDraftVersion"], ["confirmSourceChange"]) ||
        expectedDraftVersion === null ||
        expectedActiveVersion === null ||
        (body.confirmSourceChange !== undefined && body.confirmSourceChange !== true)
      ) {
        return errorJson("sign_in_configuration_invalid", 400);
      }
      const result = await deps.service.activate({
        actorUserId: read.session.userId,
        confirmSourceChange: body.confirmSourceChange === true,
        expectedActiveVersion,
        expectedDraftVersion,
        method
      });
      return result.ok
        ? Response.json({ method: result.value } satisfies AdminSignInMethodResponse)
        : failureResponse(result);
    }

    if (body.action === "disable") {
      const expectedActiveVersion = version(body.expectedActiveVersion);
      if (!hasOnlyKeys(body, ["action", "expectedActiveVersion"]) || expectedActiveVersion === null) {
        return errorJson("sign_in_configuration_invalid", 400);
      }
      const result = await deps.service.disable({
        actorUserId: read.session.userId,
        expectedActiveVersion,
        method,
        sessionId: read.session.id
      });
      return result.ok
        ? Response.json({ method: result.value } satisfies AdminSignInMethodResponse)
        : failureResponse(result);
    }

    return errorJson("sign_in_configuration_invalid", 400);
  }

  return { POST, PUT };
}

export function createAdminSignInPolicyHandler(deps: AdminSignInHandlerDeps) {
  return async function PUT(request: Request): Promise<Response> {
    const read = await readAdminJson(request, deps);
    if (read.response) return read.response;
    const body = read.body;
    const expectedVersion = body ? version(body.expectedVersion) : null;
    if (
      !body ||
      !hasOnlyKeys(body, ["expectedVersion", "passwordLoginEnabled", "registrationEnabled"]) ||
      expectedVersion === null ||
      typeof body.passwordLoginEnabled !== "boolean" ||
      typeof body.registrationEnabled !== "boolean"
    ) {
      return errorJson("sign_in_configuration_invalid", 400);
    }
    const result = await deps.service.updatePolicy({
      actorUserId: read.session.userId,
      expectedVersion,
      passwordLoginEnabled: body.passwordLoginEnabled,
      registrationEnabled: body.registrationEnabled,
      sessionId: read.session.id
    });
    return result.ok
      ? Response.json({ policy: result.value } satisfies AdminSignInPolicyResponse)
      : failureResponse(result);
  };
}
