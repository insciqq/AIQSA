import type {
  AdminEmailActionRequest,
  AdminEmailClearRequest,
  AdminEmailErrorCode,
  AdminEmailErrorResponse,
  AdminEmailMutationResponse,
  AdminEmailSaveRequest,
  AdminEmailTestResponse
} from "../../contracts/email";
import type { RequestAuthResolver } from "../auth/requestAuth";
import {
  readJsonBodyOrNull,
  requestBodyErrorResponse
} from "../http/requestBody";
import {
  normalizeSmtpConfiguration,
  normalizeSmtpProductMessage
} from "./definitions";
import { normalizeSmtpPasswordAction } from "./passwordEnvelope";
import type {
  AdminEmailService
} from "./service";
import type {
  EmailRepositoryFailureCode,
  EmailRepositoryResult
} from "./repository";

export type AdminEmailHandlerDeps = {
  resolveAuth: RequestAuthResolver;
  service: AdminEmailService;
};

function errorJson(error: AdminEmailErrorCode, status: number): Response {
  return Response.json({ error } satisfies AdminEmailErrorResponse, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  return contentType === "application/json" || contentType.endsWith("+json");
}

async function readJsonRecord(
  request: Request
): Promise<readonly [Record<string, unknown> | null, Response | null]> {
  if (!hasJsonContentType(request)) return [null, null];
  const value = await readJsonBodyOrNull(request, "json");
  return [isRecord(value) ? value : null, requestBodyErrorResponse(value)];
}

function version(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 2_147_483_647
    ? value as number
    : null;
}

async function requireAdmin(request: Request, deps: AdminEmailHandlerDeps) {
  const session = await deps.resolveAuth(request);
  if (!session) return { response: errorJson("unauthorized", 401), session: null };
  if (session.user.status !== "active" || session.user.role !== "admin") {
    return { response: errorJson("forbidden", 403), session: null };
  }
  return { response: null, session };
}

function repositoryError(code: EmailRepositoryFailureCode): Response {
  switch (code) {
    case "active_conflict":
      return errorJson("email_active_conflict", 409);
    case "draft_conflict":
      return errorJson("email_draft_conflict", 409);
    case "encryption_unavailable":
      return errorJson("email_encryption_unavailable", 503);
    case "invalid_configuration":
      return errorJson("email_configuration_invalid", 400);
    case "not_configured":
      return errorJson("email_draft_not_configured", 409);
    case "not_tested":
      return errorJson("email_draft_not_tested", 409);
    case "invalid_state":
    case "secret_unreadable":
      return errorJson("email_state_invalid", 409);
  }
}

function mutationResponse(result: EmailRepositoryResult<AdminEmailMutationResponse["email"]>): Response {
  return result.ok
    ? Response.json({ email: result.value } satisfies AdminEmailMutationResponse)
    : repositoryError(result.code);
}

function saveRequest(body: Record<string, unknown> | null): AdminEmailSaveRequest | null {
  if (!body || !hasOnlyKeys(body, ["configuration", "expectedDraftVersion", "passwordAction"])) {
    return null;
  }
  const expectedDraftVersion = version(body.expectedDraftVersion);
  if (expectedDraftVersion === null) return null;
  try {
    return {
      configuration: normalizeSmtpConfiguration(body.configuration),
      expectedDraftVersion,
      passwordAction: normalizeSmtpPasswordAction(body.passwordAction)
    };
  } catch {
    return null;
  }
}

function clearRequest(body: Record<string, unknown> | null): AdminEmailClearRequest | null {
  if (!body || !hasOnlyKeys(body, ["confirm", "expectedActiveVersion", "expectedDraftVersion"]) ||
    body.confirm !== true) {
    return null;
  }
  const expectedActiveVersion = version(body.expectedActiveVersion);
  const expectedDraftVersion = version(body.expectedDraftVersion);
  return expectedActiveVersion === null || expectedDraftVersion === null
    ? null
    : { confirm: true, expectedActiveVersion, expectedDraftVersion };
}

function actionRequest(body: Record<string, unknown> | null): AdminEmailActionRequest | null {
  if (!body || typeof body.action !== "string") return null;
  if (body.action === "activate") {
    if (!hasOnlyKeys(body, ["action", "expectedActiveVersion", "expectedDraftVersion"])) return null;
    const expectedActiveVersion = version(body.expectedActiveVersion);
    const expectedDraftVersion = version(body.expectedDraftVersion);
    return expectedActiveVersion === null || expectedDraftVersion === null
      ? null
      : { action: "activate", expectedActiveVersion, expectedDraftVersion };
  }
  if (body.action === "disable" || body.action === "enable") {
    if (!hasOnlyKeys(body, ["action", "expectedActiveVersion"])) return null;
    const expectedActiveVersion = version(body.expectedActiveVersion);
    return expectedActiveVersion === null
      ? null
      : { action: body.action, expectedActiveVersion };
  }
  if (body.action === "test") {
    if (!hasOnlyKeys(body, ["action", "expectedDraftVersion", "recipient"])) return null;
    const expectedDraftVersion = version(body.expectedDraftVersion);
    if (expectedDraftVersion === null) return null;
    try {
      const message = normalizeSmtpProductMessage({
        kind: "configuration_test",
        subject: "AIQSA email delivery configuration test",
        text: "AIQSA configuration test.",
        to: body.recipient
      });
      return { action: "test", expectedDraftVersion, recipient: message.to };
    } catch {
      return null;
    }
  }
  return null;
}

export function createAdminEmailReadHandler(deps: AdminEmailHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const auth = await requireAdmin(request, deps);
    if (!auth.session) return auth.response;
    return mutationResponse(await deps.service.read());
  };
}

export function createAdminEmailSaveHandler(deps: AdminEmailHandlerDeps) {
  return async function PUT(request: Request): Promise<Response> {
    if (!hasJsonContentType(request)) return errorJson("json_required", 415);
    const auth = await requireAdmin(request, deps);
    if (!auth.session) return auth.response;
    const [value, bodyError] = await readJsonRecord(request);
    if (bodyError) return bodyError;
    const body = saveRequest(value);
    if (!body) return errorJson("email_configuration_invalid", 400);
    return mutationResponse(await deps.service.saveDraft({
      actorUserId: auth.session.userId,
      ...body
    }));
  };
}

export function createAdminEmailClearHandler(deps: AdminEmailHandlerDeps) {
  return async function DELETE(request: Request): Promise<Response> {
    if (!hasJsonContentType(request)) return errorJson("json_required", 415);
    const auth = await requireAdmin(request, deps);
    if (!auth.session) return auth.response;
    const [value, bodyError] = await readJsonRecord(request);
    if (bodyError) return bodyError;
    const body = clearRequest(value);
    if (!body) return errorJson("email_configuration_invalid", 400);
    return mutationResponse(await deps.service.clear({
      actorUserId: auth.session.userId,
      expectedActiveVersion: body.expectedActiveVersion,
      expectedDraftVersion: body.expectedDraftVersion
    }));
  };
}

export function createAdminEmailActionHandler(deps: AdminEmailHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    if (!hasJsonContentType(request)) return errorJson("json_required", 415);
    const auth = await requireAdmin(request, deps);
    if (!auth.session) return auth.response;
    const [value, bodyError] = await readJsonRecord(request);
    if (bodyError) return bodyError;
    const action = actionRequest(value);
    if (!action) return errorJson("email_configuration_invalid", 400);

    if (action.action === "test") {
      const result = await deps.service.testDraft({
        expectedDraftVersion: action.expectedDraftVersion,
        recipient: action.recipient
      });
      return result.ok
        ? Response.json(result.value satisfies AdminEmailTestResponse)
        : repositoryError(result.code);
    }
    if (action.action === "activate") {
      return mutationResponse(await deps.service.activate({
        actorUserId: auth.session.userId,
        expectedActiveVersion: action.expectedActiveVersion,
        expectedDraftVersion: action.expectedDraftVersion
      }));
    }
    if (action.action === "enable") {
      return mutationResponse(await deps.service.enable({
        actorUserId: auth.session.userId,
        expectedActiveVersion: action.expectedActiveVersion
      }));
    }
    return mutationResponse(await deps.service.disable({
      actorUserId: auth.session.userId,
      expectedActiveVersion: action.expectedActiveVersion
    }));
  };
}
