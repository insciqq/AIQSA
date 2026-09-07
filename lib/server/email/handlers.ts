import type {
  AdminEmailActionRequest,
  AdminEmailClearRequest,
  AdminEmailDraftInput,
  AdminEmailErrorCode,
  AdminEmailErrorResponse,
  AdminEmailMutationResponse,
  AdminEmailTestFailedResponse,
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

function draftInput(value: unknown): AdminEmailDraftInput | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["configuration", "expectedDraftVersion", "passwordAction"])) {
    return null;
  }
  const expectedDraftVersion = version(value.expectedDraftVersion);
  if (expectedDraftVersion === null) return null;
  try {
    return {
      configuration: normalizeSmtpConfiguration(value.configuration),
      expectedDraftVersion,
      passwordAction: normalizeSmtpPasswordAction(value.passwordAction)
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
  if (body.action === "disable" || body.action === "enable") {
    if (!hasOnlyKeys(body, ["action", "expectedActiveVersion"])) return null;
    const expectedActiveVersion = version(body.expectedActiveVersion);
    return expectedActiveVersion === null
      ? null
      : { action: body.action, expectedActiveVersion };
  }
  if (body.action === "test_and_activate") {
    if (!hasOnlyKeys(body, ["action", "draft", "expectedActiveVersion", "testRecipient"])) return null;
    const draft = draftInput(body.draft);
    const expectedActiveVersion = version(body.expectedActiveVersion);
    if (!draft || expectedActiveVersion === null) return null;
    try {
      const message = normalizeSmtpProductMessage({
        kind: "configuration_test",
        subject: "AIQSA email delivery configuration test",
        text: "AIQSA configuration test.",
        to: body.testRecipient
      });
      return { action: "test_and_activate", draft, expectedActiveVersion, testRecipient: message.to };
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

    if (action.action === "test_and_activate") {
      const result = await deps.service.testAndActivate({
        actorUserId: auth.session.userId,
        configuration: action.draft.configuration,
        expectedActiveVersion: action.expectedActiveVersion,
        expectedDraftVersion: action.draft.expectedDraftVersion,
        passwordAction: action.draft.passwordAction,
        testRecipient: action.testRecipient
      });
      if (result.ok) return Response.json(result.value satisfies AdminEmailTestResponse);
      if (result.code === "test_failed") {
        return Response.json({
          email: result.value.email,
          error: "email_test_failed",
          test: { code: result.value.test.code, tested: false }
        } satisfies AdminEmailTestFailedResponse, { status: 422 });
      }
      return repositoryError(result.code);
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
