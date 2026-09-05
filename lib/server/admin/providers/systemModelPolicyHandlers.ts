import type { SystemModelVerificationRole } from "../../../contracts/adminSystemModelPolicy";
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
      status: error.code === "system_model_policy_stale"
        ? 409
        : error.code === "system_model_policy_verification_failed" ? 422 : 400
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
      const allowed = ["expectedVersion", "providerModelId", "reasoningEffort", "rerankerProviderModelId",
        "chatPdfPreparationAllowed", "chatPdfProviderModelId", "chatPdfReasoningEffort"];
      const textOrNull = (entry: unknown, limit: number) => entry === null ||
        typeof entry === "string" && entry.trim() === entry && entry.length > 0 && entry.length <= limit &&
        !/[\u0000-\u001f\u007f]/u.test(entry);
      const hasUtilityUpdate = record(value) && Object.hasOwn(value, "providerModelId");
      const hasRerankerUpdate = record(value) && Object.hasOwn(value, "rerankerProviderModelId");
      const hasPdfPolicyUpdate = record(value) && Object.hasOwn(value, "chatPdfPreparationAllowed");
      const hasPdfModelUpdate = record(value) && Object.hasOwn(value, "chatPdfProviderModelId");
      if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key)) ||
        !Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion) < 1 ||
        !hasUtilityUpdate && !hasRerankerUpdate && !hasPdfPolicyUpdate && !hasPdfModelUpdate ||
        hasUtilityUpdate !== Object.hasOwn(value, "reasoningEffort") ||
        hasPdfModelUpdate !== Object.hasOwn(value, "chatPdfReasoningEffort") ||
        hasUtilityUpdate && (!textOrNull(value.providerModelId, 256) || !textOrNull(value.reasoningEffort, 32)) ||
        hasPdfModelUpdate && (!textOrNull(value.chatPdfProviderModelId, 256) || !textOrNull(value.chatPdfReasoningEffort, 32)) ||
        hasRerankerUpdate && !textOrNull(value.rerankerProviderModelId, 256) ||
        hasPdfPolicyUpdate && typeof value.chatPdfPreparationAllowed !== "boolean" ||
        value.providerModelId === null && value.reasoningEffort !== null ||
        value.chatPdfProviderModelId === null && value.chatPdfReasoningEffort !== null) {
        return Response.json({ error: "system_model_policy_update_invalid" }, { status: 400 });
      }
      try {
        await input.service.update({
          ...(hasPdfPolicyUpdate ? {
            chatPdfPreparationAllowed: value.chatPdfPreparationAllowed as boolean
          } : {}),
          ...(hasPdfModelUpdate ? {
            chatPdfProviderModelId: value.chatPdfProviderModelId as string | null,
            chatPdfReasoningEffort: value.chatPdfReasoningEffort as string | null
          } : {}),
          expectedVersion: Number(value.expectedVersion),
          ...(hasUtilityUpdate ? {
            providerModelId: value.providerModelId as string | null,
            reasoningEffort: value.reasoningEffort as string | null
          } : {}),
          ...(hasRerankerUpdate
            ? { rerankerProviderModelId: value.rerankerProviderModelId as string | null }
            : {}),
          userId: auth.session.userId
        });
        return Response.json({ systemModelPolicy: await input.service.list() });
      } catch (error) {
        return failure(error);
      }
    },

    async POST(request: Request): Promise<Response> {
      if (!contentTypeIsJson(request)) {
        return Response.json({ error: "json_required" }, { status: 415 });
      }
      const auth = await requireAdmin(request, input.resolveAuth);
      if (auth.error) return auth.error;
      const value = await readJsonBodyOrNull(request, "json");
      const bodyError = requestBodyErrorResponse(value);
      if (bodyError) return bodyError;
      if (!record(value) || Object.keys(value).length !== 2 ||
        !["memory", "direct_pdf", "vision", "embedding", "reranker"].includes(String(value.role)) ||
        typeof value.providerModelId !== "string" ||
        value.providerModelId.trim() !== value.providerModelId ||
        value.providerModelId.length < 1 || value.providerModelId.length > 256 ||
        /[\u0000-\u001f\u007f]/u.test(value.providerModelId)) {
        return Response.json(
          { error: "system_model_policy_verification_invalid" },
          { status: 400 }
        );
      }
      try {
        await input.service.verifyRole({
          role: value.role as SystemModelVerificationRole,
          providerModelId: value.providerModelId,
          signal: request.signal
        });
        return Response.json({ systemModelPolicy: await input.service.list() });
      } catch (error) {
        return failure(error);
      }
    }
  };
}
