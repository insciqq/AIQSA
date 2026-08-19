import type { RequestAuthResolver } from "../../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../../http/requestBody";
import { isKnowledgeRetrievalPolicy } from "../../knowledge/knowledgePolicy";
import {
  AdminKnowledgePolicyServiceError,
  type createAdminKnowledgePolicyService
} from "./policyService";
import { AdminKnowledgeProfileServiceError } from "./profileService";

type Service = ReturnType<typeof createAdminKnowledgePolicyService>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function allowedKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function boundedId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 256 &&
    !/[\u0000-\u0020\u007f]/u.test(normalized) ? normalized : null;
}

async function requireAdmin(request: Request, resolveAuth: RequestAuthResolver) {
  const session = await resolveAuth(request);
  if (!session) return { error: Response.json({ error: "unauthorized" }, { status: 401 }), session: null };
  if (session.user.status !== "active" || session.user.role !== "admin") {
    return { error: Response.json({ error: "forbidden" }, { status: 403 }), session: null };
  }
  return { error: null, session };
}

function contentTypeIsJson(request: Request): boolean {
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "application/json" || type.endsWith("+json");
}

function failure(error: unknown): Response {
  if (error instanceof AdminKnowledgePolicyServiceError ||
    error instanceof AdminKnowledgeProfileServiceError) {
    return Response.json({ error: error.code }, { status: 409 });
  }
  console.error("knowledge_policy_admin_action_failed");
  return Response.json({ error: "knowledge_policy_admin_action_failed" }, { status: 500 });
}

export function createAdminKnowledgePolicyHandlers(input: Readonly<{
  resolveAuth: RequestAuthResolver;
  service: Service;
}>) {
  return {
    async GET(request: Request): Promise<Response> {
      const auth = await requireAdmin(request, input.resolveAuth);
      if (auth.error) return auth.error;
      try {
        return Response.json({ knowledge: await input.service.list() });
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
      if (record(value) && value.action === "activate_profile") {
        const deploymentId = boundedId(value.deploymentId);
        const visionDeploymentId = value.visionDeploymentId === null
          ? null
          : boundedId(value.visionDeploymentId);
        if (!allowedKeys(value, ["action", "deploymentId", "expectedVersion", "visionDeploymentId"]) ||
          !deploymentId || !Number.isSafeInteger(value.expectedVersion) ||
          Number(value.expectedVersion) < 1 ||
          !("visionDeploymentId" in value) ||
          value.visionDeploymentId !== null && !visionDeploymentId) {
          return Response.json({ error: "knowledge_profile_input_invalid" }, { status: 400 });
        }
        try {
          await input.service.activateProfile({
            deploymentId,
            expectedVersion: Number(value.expectedVersion),
            userId: auth.session.userId,
            visionDeploymentId
          });
          return Response.json({ knowledge: await input.service.list() });
        } catch (error) {
          return failure(error);
        }
      }
      if (record(value) && value.action === "rollback_profile") {
        const revisionId = boundedId(value.revisionId);
        if (!allowedKeys(value, ["action", "expectedVersion", "revisionId"]) ||
          !revisionId || !Number.isSafeInteger(value.expectedVersion) ||
          Number(value.expectedVersion) < 1) {
          return Response.json({ error: "knowledge_profile_input_invalid" }, { status: 400 });
        }
        try {
          await input.service.rollbackProfile({
            expectedVersion: Number(value.expectedVersion),
            revisionId,
            userId: auth.session.userId
          });
          return Response.json({ knowledge: await input.service.list() });
        } catch (error) {
          return failure(error);
        }
      }
      const policy = record(value) ? {
        candidateLimit: value.candidateLimit as number,
        resultLimit: value.resultLimit as number,
        scoreThreshold: value.scoreThreshold as number
      } : null;
      if (!record(value) ||
        !allowedKeys(value, ["candidateLimit", "expectedVersion", "resultLimit", "scoreThreshold"]) ||
        !Number.isSafeInteger(value.expectedVersion) ||
        Number(value.expectedVersion) < 1 || !policy || !isKnowledgeRetrievalPolicy(policy)) {
        return Response.json({ error: "knowledge_policy_update_invalid" }, { status: 400 });
      }
      try {
        await input.service.update({
          ...policy,
          expectedVersion: Number(value.expectedVersion),
          userId: auth.session.userId
        });
        return Response.json({ knowledge: await input.service.list() });
      } catch (error) {
        return failure(error);
      }
    }
  };
}
