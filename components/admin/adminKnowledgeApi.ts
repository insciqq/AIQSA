import {
  decodeAdminKnowledgeResponse,
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
          : "knowledge_policy_admin_action_failed",
        ok: false
      };
    }
    const decoded = decodeAdminKnowledgeResponse(value);
    return decoded
      ? { data: decoded.knowledge, ok: true }
      : { error: "knowledge_policy_response_invalid", ok: false };
  } catch {
    return { error: "network_error", ok: false };
  }
}

export function getAdminKnowledgeSettings(fetcher: Fetcher = fetch) {
  return request({ method: "GET" }, fetcher);
}

export function updateAdminKnowledgePolicy(input: Readonly<{
  candidateLimit: number;
  expectedVersion: number;
  resultLimit: number;
  scoreThreshold: number;
}>, fetcher: Fetcher = fetch) {
  return request({
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
    method: "PATCH"
  }, fetcher);
}

export function adminKnowledgeErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    knowledge_policy_admin_action_failed: "Knowledge settings could not be updated.",
    knowledge_policy_response_invalid: "The Knowledge settings response was invalid.",
    knowledge_policy_stale: "Knowledge settings changed elsewhere. Refresh before saving again.",
    network_error: "Knowledge settings could not be reached."
  };
  return messages[code] ?? code.replaceAll("_", " ");
}
