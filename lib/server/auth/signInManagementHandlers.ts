import type {
  AdminGroupSignInErrorCode,
  AdminGroupSignInResponse,
  AdminUserSignInErrorCode,
  AdminUserSignInResponse
} from "@/lib/contracts/adminSignIn";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import type { AuthenticatedSession, RequestAuthResolver } from "./requestAuth";
import type {
  CurrentIdentitySources,
  SignInManagementFailureCode,
  SignInManagementRepository
} from "./signInManagement";

export type AdminSignInManagementHandlerDeps = {
  /** The source each admin-active method binds identities to. */
  currentIdentitySources(): Promise<CurrentIdentitySources>;
  repository: SignInManagementRepository;
  resolveAuth: RequestAuthResolver;
};

type GroupRouteContext = { params: Promise<{ groupId: string }> | { groupId: string } };
type UserRouteContext = { params: Promise<{ userId: string }> | { userId: string } };

const MAX_ID_LENGTH = 200;

function errorJson(error: AdminGroupSignInErrorCode | AdminUserSignInErrorCode, status: number): Response {
  return Response.json({ error }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((key) => key in value) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function identifier(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  return contentType === "application/json" || contentType.endsWith("+json");
}

async function requireAdmin(
  request: Request,
  deps: AdminSignInManagementHandlerDeps
): Promise<{ response: Response; session: null } | { response: null; session: AuthenticatedSession }> {
  const session = await deps.resolveAuth(request);
  if (!session) return { response: errorJson("unauthorized", 401), session: null };
  if (session.user.status !== "active" || session.user.role !== "admin") {
    return { response: errorJson("forbidden", 403), session: null };
  }
  return { response: null, session };
}

async function readAdminJson(
  request: Request,
  deps: AdminSignInManagementHandlerDeps
): Promise<{ body: Record<string, unknown> | null; response: null } | { response: Response }> {
  if (!hasJsonContentType(request)) return { response: errorJson("json_required", 415) };
  const auth = await requireAdmin(request, deps);
  if (!auth.session) return { response: auth.response };
  const value = await readJsonBodyOrNull(request, "json");
  const bodyError = requestBodyErrorResponse(value);
  if (bodyError) return { response: bodyError };
  return { body: isRecord(value) ? value : null, response: null };
}

function failureResponse(code: SignInManagementFailureCode): Response {
  switch (code) {
    case "group_not_found":
    case "external_name_not_found":
    case "identity_not_found":
    case "user_not_found":
      return errorJson(code, 404);
    case "external_name_duplicate":
    case "external_name_limit":
    case "group_archived":
    case "identity_last_sign_in_method":
      return errorJson(code, 409);
    case "external_name_invalid":
    case "identity_unlink_forbidden":
      return errorJson(code, 400);
  }
}

/** External group names of one group, and which of its memberships an IdP manages. */
export function createAdminGroupSignInHandlers(deps: AdminSignInManagementHandlerDeps) {
  async function GET(request: Request, context: GroupRouteContext): Promise<Response> {
    const auth = await requireAdmin(request, deps);
    if (!auth.session) return auth.response;
    const groupId = identifier((await context.params).groupId);
    const group = groupId ? await deps.repository.readGroup(groupId) : null;
    return group
      ? Response.json({ group } satisfies AdminGroupSignInResponse)
      : errorJson("group_not_found", 404);
  }

  async function POST(request: Request, context: GroupRouteContext): Promise<Response> {
    const read = await readAdminJson(request, deps);
    if (read.response) return read.response;
    const groupId = identifier((await context.params).groupId);
    if (!groupId) return errorJson("group_not_found", 404);
    const body = read.body;
    if (body?.action === "add_external_name" && hasOnlyKeys(body, ["action", "source", "value"])) {
      const result = await deps.repository.addExternalName({ groupId, source: body.source, value: body.value });
      return result.ok ? Response.json({ group: result.value } satisfies AdminGroupSignInResponse) : failureResponse(result.code);
    }
    if (body?.action === "remove_external_name" && hasOnlyKeys(body, ["action", "externalNameId"])) {
      const externalNameId = identifier(body.externalNameId);
      if (!externalNameId) return errorJson("external_name_not_found", 404);
      const result = await deps.repository.removeExternalName({ externalNameId, groupId });
      return result.ok ? Response.json({ group: result.value } satisfies AdminGroupSignInResponse) : failureResponse(result.code);
    }
    return errorJson("external_name_invalid", 400);
  }

  return { GET, POST };
}

/** One user's sign-in identities, IdP-managed memberships and identity unlinking. */
export function createAdminUserSignInHandlers(deps: AdminSignInManagementHandlerDeps) {
  async function GET(request: Request, context: UserRouteContext): Promise<Response> {
    const auth = await requireAdmin(request, deps);
    if (!auth.session) return auth.response;
    const userId = identifier((await context.params).userId);
    const user = userId ? await deps.repository.readUser(userId, await deps.currentIdentitySources()) : null;
    return user
      ? Response.json({ user } satisfies AdminUserSignInResponse)
      : errorJson("user_not_found", 404);
  }

  async function POST(request: Request, context: UserRouteContext): Promise<Response> {
    const read = await readAdminJson(request, deps);
    if (read.response) return read.response;
    const userId = identifier((await context.params).userId);
    if (!userId) return errorJson("user_not_found", 404);
    const body = read.body;
    const identityId = body ? identifier(body.identityId) : null;
    if (
      !body ||
      body.action !== "unlink_identity" ||
      !hasOnlyKeys(body, ["action", "identityId"], ["confirmLastSignInMethod"]) ||
      (body.confirmLastSignInMethod !== undefined && body.confirmLastSignInMethod !== true)
    ) {
      return errorJson("identity_unlink_forbidden", 400);
    }
    if (!identityId) return errorJson("identity_not_found", 404);
    const result = await deps.repository.unlinkIdentity({
      confirmLastSignInMethod: body.confirmLastSignInMethod === true,
      currentSources: await deps.currentIdentitySources(),
      identityId,
      userId
    });
    return result.ok ? Response.json({ user: result.value } satisfies AdminUserSignInResponse) : failureResponse(result.code);
  }

  return { GET, POST };
}
