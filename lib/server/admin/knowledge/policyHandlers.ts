import type { RequestAuthResolver } from "../../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../../http/requestBody";
import {
  KNOWLEDGE_INGESTION_PARALLELISM_MAXIMUM,
  KNOWLEDGE_INGESTION_PARALLELISM_MINIMUM
} from "../../knowledge/ingestionCoordinator";
import type { createAdminKnowledgePolicyService } from "./policyService";
import { AdminKnowledgeProfileServiceError } from "./profileService";
import { AdminKnowledgeAnswerPolicyServiceError } from "./answerPolicyService";

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

function pdfProcessingMode(value: unknown) {
  return value === "local" || value === "system_model_direct_pdf" ||
    value === "system_model_vision" ? value : null;
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
  if (error instanceof AdminKnowledgeAnswerPolicyServiceError) {
    return Response.json({ error: error.code }, {
      status: error.code === "knowledge_answer_policy_stale" ||
        error.code === "knowledge_ingestion_parallelism_stale" ? 409 : 400
    });
  }
  if (error instanceof AdminKnowledgeProfileServiceError) {
    return Response.json({ error: error.code }, { status: 409 });
  }
  console.error("knowledge_admin_action_failed");
  return Response.json({ error: "knowledge_admin_action_failed" }, { status: 500 });
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
        const mode = pdfProcessingMode(value.pdfProcessingMode);
        if (!allowedKeys(value, [
          "action",
          "deploymentId",
          "expectedVersion",
          "pdfProcessingMode",
          "documentDeploymentId"
        ]) || !deploymentId || !mode || !Number.isSafeInteger(value.expectedVersion) ||
          Number(value.expectedVersion) < 1 ||
          (mode === "local" ? value.documentDeploymentId !== null : !boundedId(value.documentDeploymentId))) {
          return Response.json({ error: "knowledge_profile_input_invalid" }, { status: 400 });
        }
        try {
          await input.service.activateProfile({
            deploymentId,
            expectedVersion: Number(value.expectedVersion),
            pdfProcessingMode: mode,
            documentDeploymentId: mode === "local" ? null : boundedId(value.documentDeploymentId),
            userId: auth.session.userId
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
      if (record(value) && value.action === "update_ingestion_parallelism") {
        if (!allowedKeys(value, [
          "action",
          "expectedVersion",
          "ingestionParallelism"
        ]) || !Number.isSafeInteger(value.expectedVersion) ||
          Number(value.expectedVersion) < 1 ||
          !Number.isSafeInteger(value.ingestionParallelism) ||
          Number(value.ingestionParallelism) < KNOWLEDGE_INGESTION_PARALLELISM_MINIMUM ||
          Number(value.ingestionParallelism) > KNOWLEDGE_INGESTION_PARALLELISM_MAXIMUM) {
          return Response.json({ error: "knowledge_ingestion_parallelism_invalid" }, { status: 400 });
        }
        try {
          await input.service.updateIngestionParallelism({
            expectedVersion: Number(value.expectedVersion),
            ingestionParallelism: Number(value.ingestionParallelism),
            userId: auth.session.userId
          });
          return Response.json({ knowledge: await input.service.list() });
        } catch (error) {
          return failure(error);
        }
      }
      if (record(value) && value.action === "update_answer_policy") {
        if (!allowedKeys(value, [
          "action",
          "expectedVersion",
          "maximumKnowledgeSearches"
        ]) || !Number.isSafeInteger(value.expectedVersion) ||
          Number(value.expectedVersion) < 1 ||
          !Number.isSafeInteger(value.maximumKnowledgeSearches) ||
          Number(value.maximumKnowledgeSearches) < 1 ||
          Number(value.maximumKnowledgeSearches) > 32) {
          return Response.json({ error: "knowledge_answer_policy_invalid" }, { status: 400 });
        }
        try {
          await input.service.updateAnswerPolicy({
            expectedVersion: Number(value.expectedVersion),
            maximumKnowledgeSearches: Number(value.maximumKnowledgeSearches),
            userId: auth.session.userId
          });
          return Response.json({ knowledge: await input.service.list() });
        } catch (error) {
          return failure(error);
        }
      }
      return Response.json({ error: "knowledge_profile_input_invalid" }, { status: 400 });
    }
  };
}
