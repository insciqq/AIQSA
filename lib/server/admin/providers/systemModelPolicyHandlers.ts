import type { RequestAuthResolver } from "../../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../../http/requestBody";
import {
  AdminSystemModelPolicyServiceError,
  type createAdminSystemModelPolicyService
} from "./systemModelPolicyService";

type Service = ReturnType<typeof createAdminSystemModelPolicyService>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requireAdmin(request: Request, resolveAuth: RequestAuthResolver) {
  const session = await resolveAuth(request);
  if (!session) {
    return {
      error: Response.json({ error: "unauthorized" }, { status: 401 }),
      session: null
    };
  }
  if (session.user.status !== "active" || session.user.role !== "admin") {
    return {
      error: Response.json({ error: "forbidden" }, { status: 403 }),
      session: null
    };
  }
  return { error: null, session };
}

function contentTypeIsJson(request: Request): boolean {
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "application/json" || type.endsWith("+json");
}

function failure(error: unknown): Response {
  if (error instanceof AdminSystemModelPolicyServiceError) {
    return Response.json({ error: error.code }, {
      status: error.code === "system_model_policy_stale" ? 409 : 400
    });
  }
  console.error("system_model_policy_admin_action_failed");
  return Response.json(
    { error: "system_model_policy_admin_action_failed" },
    { status: 500 }
  );
}

export function createAdminSystemModelPolicyHandlers(input: Readonly<{
  resolveAuth: RequestAuthResolver;
  service: Service;
}>) {
  return {
    async GET(request: Request): Promise<Response> {
      const auth = await requireAdmin(request, input.resolveAuth);
      if (auth.error) return auth.error;
      try {
        return Response.json({ systemModelPolicy: await input.service.list() });
      } catch (error) {
        return failure(error);
      }
    },

    async PATCH(request: Request): Promise<Response> {
      if (!contentTypeIsJson(request)) {
        return Response.json({ error: "json_required" }, { status: 415 });
      }
      const auth = await requireAdmin(request, input.resolveAuth);
      if (auth.error || !auth.session) return auth.error!;
      const value = await readJsonBodyOrNull(request, "json");
      const bodyError = requestBodyErrorResponse(value);
      if (bodyError) return bodyError;
      if (!record(value) || !Number.isSafeInteger(value.expectedVersion) ||
        Number(value.expectedVersion) < 1 ||
        !(value.providerModelId === null || typeof value.providerModelId === "string" &&
          value.providerModelId.trim() === value.providerModelId &&
          value.providerModelId.length > 0 && value.providerModelId.length <= 256 &&
          !/[\u0000-\u001f\u007f]/u.test(value.providerModelId))) {
        return Response.json({ error: "system_model_policy_update_invalid" }, { status: 400 });
      }
      try {
        await input.service.update({
          expectedVersion: Number(value.expectedVersion),
          providerModelId: value.providerModelId,
          userId: auth.session.userId
        });
        return Response.json({ systemModelPolicy: await input.service.list() });
      } catch (error) {
        return failure(error);
      }
    }
  };
}
