import {
  decodeAdminModelPolicyResponse,
  type AdminModelPolicyCatalog
} from "@/lib/contracts/adminModelPolicy";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AdminModelPolicyResult =
  | { data: AdminModelPolicyCatalog; ok: true }
  | { error: string; ok: false };

async function request(init: RequestInit, fetcher: Fetcher): Promise<AdminModelPolicyResult> {
  try {
    const response = await fetcher("/api/admin/providers/model-policy", {
      credentials: "same-origin",
      ...init
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        error: typeof value === "object" && value !== null &&
          typeof (value as Record<string, unknown>).error === "string"
          ? String((value as Record<string, unknown>).error)
          : "model_policy_admin_action_failed",
        ok: false
      };
    }
    const decoded = decodeAdminModelPolicyResponse(value);
    return decoded
      ? { data: decoded.modelPolicy, ok: true }
      : { error: "model_policy_response_invalid", ok: false };
  } catch {
    return { error: "network_error", ok: false };
  }
}

export function getAdminModelPolicy(fetcher: Fetcher = fetch) {
  return request({ method: "GET" }, fetcher);
}

export function updateAdminModelPolicy(input: Readonly<{
  expectedVersion: number;
  providerModelId: string | null;
}>, fetcher: Fetcher = fetch) {
  return request({
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
    method: "PATCH"
  }, fetcher);
}

export function updateAdminToolBudgets(input: Readonly<{
  expectedVersion: number;
  maxToolCalls: number;
  maxToolRounds: number;
}>, fetcher: Fetcher = fetch) {
  return request({
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
    method: "PATCH"
  }, fetcher);
}

export function adminModelPolicyErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    model_policy_admin_action_failed: "The installation default could not be updated.",
    model_policy_response_invalid: "The installation default response was invalid.",
    model_policy_stale: "The installation default changed elsewhere. Reload and apply your choice again.",
    model_policy_target_unavailable: "Choose an active answer model deployment.",
    network_error: "The installation default could not be reached."
  };
  return messages[code] ?? code.replaceAll("_", " ");
}
