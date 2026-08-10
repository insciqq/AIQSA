import {
  decodeAdminMemoryEgressResponse,
  type AdminMemoryEgressAcknowledgeInput,
  type AdminMemoryEgressSettings
} from "@/lib/contracts/adminMemory";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AdminMemoryResult =
  | { data: AdminMemoryEgressSettings; ok: true }
  | { error: string; ok: false };

async function request(init: RequestInit, fetcher: Fetcher): Promise<AdminMemoryResult> {
  try {
    const response = await fetcher("/api/admin/memory", {
      credentials: "same-origin",
      ...init
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        error: typeof value === "object" && value !== null &&
          typeof (value as Record<string, unknown>).error === "string"
          ? String((value as Record<string, unknown>).error)
          : "memory_admin_egress_action_failed",
        ok: false
      };
    }
    const decoded = decodeAdminMemoryEgressResponse(value);
    return decoded
      ? { data: decoded.memoryEgress, ok: true }
      : { error: "memory_admin_egress_response_invalid", ok: false };
  } catch {
    return { error: "network_error", ok: false };
  }
}

export function getAdminMemoryEgress(fetcher: Fetcher = fetch) {
  return request({ method: "GET" }, fetcher);
}

export function acknowledgeAdminMemoryEgress(
  input: AdminMemoryEgressAcknowledgeInput,
  fetcher: Fetcher = fetch
) {
  return request({
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
    method: "PATCH"
  }, fetcher);
}

export function adminMemoryErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    forbidden: "Your account can no longer manage installation Memory destinations.",
    memory_admin_egress_action_failed: "Memory destination policy could not be loaded.",
    memory_admin_egress_input_invalid: "The Memory destination review is no longer valid. Refresh and try again.",
    memory_admin_egress_per_user_mode: "This installation delegates destination review to each user.",
    memory_admin_egress_policy_changed: "Memory destinations changed during review. Refresh before acknowledging them.",
    memory_admin_egress_policy_missing: "The installation Memory destination policy is unavailable.",
    memory_admin_egress_response_invalid: "The Memory destination response was invalid.",
    memory_admin_egress_stale: "Another administrator updated Memory destinations. Refresh to review the current policy.",
    network_error: "Memory destination policy could not be reached.",
    unauthorized: "Your administrator session has expired. Sign in again to continue."
  };
  return messages[code] ?? "Memory destination policy could not be updated.";
}
