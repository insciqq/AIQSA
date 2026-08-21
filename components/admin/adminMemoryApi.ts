import {
  decodeAdminMemoryStatusResponse,
  type AdminMemoryStatusResponse
} from "@/lib/contracts/adminMemory";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AdminMemoryResult =
  | { data: AdminMemoryStatusResponse; ok: true }
  | { error: string; ok: false };

async function request(init: RequestInit, fetcher: Fetcher): Promise<AdminMemoryResult> {
  try {
    const response = await fetcher("/api/admin/memory", {
      cache: "no-store",
      credentials: "same-origin",
      ...init
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        error: typeof value === "object" && value !== null &&
          typeof (value as Record<string, unknown>).error === "string"
          ? String((value as Record<string, unknown>).error)
          : "memory_admin_status_failed",
        ok: false
      };
    }
    const decoded = decodeAdminMemoryStatusResponse(value);
    return decoded
      ? { data: decoded, ok: true }
      : { error: "memory_admin_status_response_invalid", ok: false };
  } catch {
    return { error: "network_error", ok: false };
  }
}

export function getAdminMemoryStatus(fetcher: Fetcher = fetch) {
  return request({ method: "GET" }, fetcher);
}

export function startAdminMemoryRebuild(fetcher: Fetcher = fetch) {
  return request({
    body: JSON.stringify({ action: "REBUILD_REQUIRED" }),
    headers: { "content-type": "application/json" },
    method: "POST"
  }, fetcher);
}

export function updateAdminMemoryAdmissionTimeout(
  expectedVersion: number,
  timeoutSeconds: number,
  fetcher: Fetcher = fetch
) {
  return request({
    body: JSON.stringify({ expectedVersion, timeoutSeconds }),
    headers: { "content-type": "application/json" },
    method: "PUT"
  }, fetcher);
}

export function adminMemoryErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    forbidden: "Your account can no longer view installation Memory status.",
    json_required: "The rebuild request format was not accepted. Refresh and try again.",
    memory_admin_rebuild_input_invalid: "The rebuild request is no longer valid. Refresh and try again.",
    memory_admin_rebuild_not_required: "The current Memory index does not need a rebuild.",
    memory_admin_rebuild_unavailable: "The Memory rebuild cannot start yet. Check the worker and model setup, then refresh.",
    memory_admin_status_failed: "Memory status could not be loaded.",
    memory_admin_status_response_invalid: "The Memory status response was invalid.",
    memory_admin_timeout_input_invalid: "Enter a whole-number Memory timeout within the allowed range.",
    memory_admin_timeout_stale: "The Memory timeout changed in another session. Refresh and try again.",
    network_error: "Memory status could not be reached.",
    unauthorized: "Your administrator session has expired. Sign in again to continue."
  };
  return messages[code] ?? "Memory status could not be updated.";
}
