import {
  decodeAdminKnowledgeResponse,
  type AdminKnowledgePdfProcessingMode,
  type AdminKnowledgeSettings
} from "@/lib/contracts/adminKnowledge";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AdminKnowledgeResult =
  | { data: AdminKnowledgeSettings; ok: true }
  | { error: string; ok: false };

async function request(init: RequestInit, fetcher: Fetcher): Promise<AdminKnowledgeResult> {
  try {
    const response = await fetcher("/api/admin/knowledge", {
      credentials: "same-origin",
      ...init
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        error: typeof value === "object" && value !== null &&
          typeof (value as Record<string, unknown>).error === "string"
          ? String((value as Record<string, unknown>).error)
          : "knowledge_admin_action_failed",
        ok: false
      };
    }
    const decoded = decodeAdminKnowledgeResponse(value);
    return decoded
      ? { data: decoded.knowledge, ok: true }
      : { error: "knowledge_response_invalid", ok: false };
  } catch {
    return { error: "network_error", ok: false };
  }
}

export function getAdminKnowledgeSettings(fetcher: Fetcher = fetch) {
  return request({ method: "GET" }, fetcher);
}

export function activateAdminKnowledgeProfile(input: Readonly<{
  deploymentId: string;
  expectedVersion: number;
  pdfProcessingMode: AdminKnowledgePdfProcessingMode;
  documentDeploymentId: string | null;
}>, fetcher: Fetcher = fetch) {
  return request({
    body: JSON.stringify({ action: "activate_profile", ...input }),
    headers: { "content-type": "application/json" },
    method: "PATCH"
  }, fetcher);
}

export function rollbackAdminKnowledgeProfile(input: Readonly<{
  expectedVersion: number;
  revisionId: string;
}>, fetcher: Fetcher = fetch) {
  return request({
    body: JSON.stringify({ action: "rollback_profile", ...input }),
    headers: { "content-type": "application/json" },
    method: "PATCH"
  }, fetcher);
}

export function updateAdminKnowledgeAnswerPolicy(input: Readonly<{
  expectedVersion: number;
  maximumKnowledgeSearches: number;
}>, fetcher: Fetcher = fetch) {
  return request({
    body: JSON.stringify({ action: "update_answer_policy", ...input }),
    headers: { "content-type": "application/json" },
    method: "PATCH"
  }, fetcher);
}

export function updateAdminKnowledgeIngestionParallelism(input: Readonly<{
  expectedVersion: number;
  ingestionParallelism: number;
}>, fetcher: Fetcher = fetch) {
  return request({
    body: JSON.stringify({ action: "update_ingestion_parallelism", ...input }),
    headers: { "content-type": "application/json" },
    method: "PATCH"
  }, fetcher);
}

export function adminKnowledgeErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    knowledge_admin_action_failed: "Knowledge settings could not be updated.",
    knowledge_answer_policy_invalid: "Choose between 1 and 32 Knowledge searches.",
    knowledge_answer_policy_stale: "Answer retrieval settings changed elsewhere. Refresh and try again.",
    knowledge_ingestion_parallelism_invalid: "Choose between 1 and 64 parallel documents.",
    knowledge_ingestion_parallelism_stale: "Document processing settings changed elsewhere. Refresh and try again.",
    knowledge_pdf_processing_mode_unavailable: "That PDF processing route is not verified on the selected document model.",
    knowledge_response_invalid: "The Knowledge settings response was invalid.",
    knowledge_profile_destination_unavailable: "That processing destination is no longer ready. Check its provider connection and refresh.",
    knowledge_profile_input_invalid: "The processing profile request was invalid. Refresh and try again.",
    knowledge_profile_revision_unavailable: "That earlier processing profile can no longer be activated.",
    knowledge_profile_stale: "The processing profile changed elsewhere. Refresh before activating it.",
    network_error: "Knowledge settings could not be reached."
  };
  return messages[code] ?? code.replaceAll("_", " ");
}
