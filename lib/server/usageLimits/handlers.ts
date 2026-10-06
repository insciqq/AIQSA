import {
  decodeAdminUsageGroupLimitsInput,
  decodeAdminUsageInstallationLimitsInput,
  decodeAdminUsageUserLimitsInput,
  type AdminUsageLimitsErrorCode,
  type AdminUsageLimitsErrorResponse,
  type AdminUsageLimitsResponse
} from "../../contracts/usageLimits";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import type { UsageLimitsRepository } from "./repository";

const ERROR_STATUS: Readonly<Record<AdminUsageLimitsErrorCode, number>> = {
  forbidden: 403,
  group_not_found: 404,
  json_required: 415,
  unauthorized: 401,
  usage_limits_action_failed: 503,
  usage_limits_input_invalid: 400,
  usage_limits_stale: 409,
  user_not_found: 404
};

function reply(body: AdminUsageLimitsErrorResponse | AdminUsageLimitsResponse, status = 200): Response {
  return Response.json(body, { headers: { "cache-control": "private, no-store" }, status });
}

function failure(code: AdminUsageLimitsErrorCode): Response {
  return reply({ error: code }, ERROR_STATUS[code]);
}

/** Route ids are opaque; a malformed one names no resource. */
function resourceId(value: string): string | null {
  return value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
}

function isJson(request: Request): boolean {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return contentType === "application/json" || Boolean(contentType?.endsWith("+json"));
}

type Mutation = (adminUserId: string, body: unknown) => Promise<AdminUsageLimitsErrorCode | null>;

/**
 * Administrator usage limits. Every successful call answers with the whole
 * current view, so the page never merges partial state.
 */
export function createAdminUsageLimitsHandlers(input: Readonly<{
  now?: () => Date;
  repository: UsageLimitsRepository;
  resolveAuth: RequestAuthResolver;
}>) {
  const now = input.now ?? (() => new Date());
  const { repository } = input;

  async function handle(request: Request, mutation: Mutation | null, body: "json" | "none" = "json"): Promise<Response> {
    const session = await input.resolveAuth(request);
    if (!session) return failure("unauthorized");
    if (session.user.status !== "active" || session.user.role !== "admin") return failure("forbidden");
    try {
      if (mutation) {
        let value: unknown = null;
        if (body === "json") {
          if (!isJson(request)) return failure("json_required");
          value = await readJsonBodyOrNull(request, "json");
          const bodyError = requestBodyErrorResponse(value);
          if (bodyError) return bodyError;
        }
        const error = await mutation(session.userId, value);
        if (error) return failure(error);
      }
      return reply({ limits: await repository.readAdminUsageLimits(now()) });
    } catch {
      console.error("usage_limits_action_failed");
      return failure("usage_limits_action_failed");
    }
  }

  return {
    GET: (request: Request) => handle(request, null),

    updateInstallation: (request: Request) => handle(request, async (adminUserId, body) => {
      const limits = decodeAdminUsageInstallationLimitsInput(body);
      if (!limits) return "usage_limits_input_invalid";
      return await repository.updateInstallation({ ...limits, userId: adminUserId }) ? null : "usage_limits_stale";
    }),

    putGroup: (request: Request, rawGroupId: string) => handle(request, async (adminUserId, body) => {
      const groupId = resourceId(rawGroupId);
      if (!groupId) return "group_not_found";
      const limits = decodeAdminUsageGroupLimitsInput(body);
      if (!limits) return "usage_limits_input_invalid";
      return await repository.putGroupLimits({ groupId, limits, userId: adminUserId }) ? null : "group_not_found";
    }),

    putUser: (request: Request, rawUserId: string) => handle(request, async (adminUserId, body) => {
      const targetUserId = resourceId(rawUserId);
      if (!targetUserId) return "user_not_found";
      const limits = decodeAdminUsageUserLimitsInput(body);
      if (!limits) return "usage_limits_input_invalid";
      return await repository.putUserLimits({ limits, targetUserId, userId: adminUserId }) ? null : "user_not_found";
    }),

    deleteUser: (request: Request, rawUserId: string) => handle(request, async () => {
      const targetUserId = resourceId(rawUserId);
      if (!targetUserId) return "user_not_found";
      return await repository.deleteUserLimits({ targetUserId }) ? null : "user_not_found";
    }, "none")
  };
}
