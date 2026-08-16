import {
  decodeAdminSystemModelPolicyResponse,
  type AdminSystemModelPolicyCatalog
} from "@/lib/contracts/adminSystemModelPolicy";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AdminSystemModelPolicyResult =
  | { data: AdminSystemModelPolicyCatalog; ok: true }
  | { error: string; ok: false };

async function request(
  init: RequestInit,
  fetcher: Fetcher
): Promise<AdminSystemModelPolicyResult> {
  try {
    const response = await fetcher("/api/admin/providers/system-model-policy", {
      credentials: "same-origin",
      ...init
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        error: typeof value === "object" && value !== null &&
          typeof (value as Record<string, unknown>).error === "string"
          ? String((value as Record<string, unknown>).error)
          : "system_model_policy_admin_action_failed",
        ok: false
      };
    }
    const decoded = decodeAdminSystemModelPolicyResponse(value);
    return decoded
      ? { data: decoded.systemModelPolicy, ok: true }
      : { error: "system_model_policy_response_invalid", ok: false };
  } catch {
    return { error: "network_error", ok: false };
  }
}

export function getAdminSystemModelPolicy(fetcher: Fetcher = fetch) {
  return request({ method: "GET" }, fetcher);
}

export function updateAdminSystemModelPolicy(input: Readonly<{
  expectedVersion: number;
  providerModelId: string | null;
  reasoningEffort: string | null;
}>, fetcher: Fetcher = fetch) {
  return request({
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
    method: "PATCH"
  }, fetcher);
}

export function verifyAdminSystemModelStructuredOutput(
  providerModelId: string,
  fetcher: Fetcher = fetch
) {
  return request({
    body: JSON.stringify({ providerModelId }),
    headers: { "content-type": "application/json" },
    method: "POST"
  }, fetcher);
}

export function adminSystemModelPolicyErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    network_error: "The system model policy could not be reached.",
    system_model_policy_admin_action_failed: "The system model policy could not be updated.",
    system_model_policy_response_invalid: "The system model policy response was invalid.",
    system_model_policy_reasoning_unavailable: "Choose a reasoning effort advertised by the selected system model.",
    system_model_policy_stale: "The system model changed elsewhere. Reload and apply your choice again.",
    system_model_policy_structured_output_unsupported: "MCP Auto verification is not supported for this adapter.",
    system_model_policy_target_unavailable: "Choose an answer model available through your administrator provider access.",
    system_model_policy_verification_failed: "Structured output verification failed. Check the model route and installation-default credential, then try again.",
    system_model_policy_verification_invalid: "Reload the current system model and try verification again."
  };
  return messages[code] ?? code.replaceAll("_", " ");
}
