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

export type AdminModelPolicyUpdateInput = Readonly<{
  expectedVersion: number;
  /** The default model pair travels together; omit both to leave it alone. */
  providerModelId?: string | null;
  reasoningEffort?: string | null;
  /** The four tool limits travel together; omit all to leave them alone. */
  maxMcpToolsPerDiscovery?: number;
  maxToolCalls?: number;
  maxToolRounds?: number;
  mcpAutoDiscoveryTimeoutSeconds?: number;
}>;

/** One PATCH for the Chat defaults card: model and limits under one version. */
export function updateAdminModelPolicy(input: AdminModelPolicyUpdateInput, fetcher: Fetcher = fetch) {
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
    model_policy_reasoning_invalid: "Choose a reasoning effort supported by the selected model.",
    network_error: "The installation default could not be reached."
  };
  return messages[code] ?? code.replaceAll("_", " ");
}
