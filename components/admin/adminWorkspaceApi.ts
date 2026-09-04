import {
  decodeWorkspacePolicyResponse,
  type WorkspacePolicyWire
} from "@/lib/contracts/workspace";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AdminWorkspaceResult =
  | { data: WorkspacePolicyWire; ok: true }
  | { error: string; ok: false };

async function request(init: RequestInit, fetcher: Fetcher): Promise<AdminWorkspaceResult> {
  try {
    const response = await fetcher("/api/admin/workspace", {
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
          : "workspace_policy_failed",
        ok: false
      };
    }
    const decoded = decodeWorkspacePolicyResponse(value);
    return decoded
      ? { data: decoded, ok: true }
      : { error: "workspace_policy_response_invalid", ok: false };
  } catch {
    return { error: "network_error", ok: false };
  }
}

export function getAdminWorkspacePolicy(fetcher: Fetcher = fetch) {
  return request({ method: "GET" }, fetcher);
}

export function updateAdminWorkspacePolicy(
  expectedVersion: number,
  patch: Readonly<{ enabled?: boolean; internetEnabled?: boolean }>,
  fetcher: Fetcher = fetch
) {
  return request({
    body: JSON.stringify({ expectedVersion, ...patch }),
    headers: { "content-type": "application/json" },
    method: "PATCH"
  }, fetcher);
}

export function adminWorkspaceErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    forbidden: "Your account can no longer manage Workspace.",
    network_error: "Workspace policy could not be reached.",
    unauthorized: "Your administrator session has expired. Sign in again to continue.",
    workspace_policy_action_failed: "Workspace policy could not be updated.",
    workspace_policy_failed: "Workspace policy could not be loaded.",
    workspace_policy_input_invalid: "The Workspace policy change was not accepted.",
    workspace_policy_response_invalid: "The Workspace policy response was invalid.",
    workspace_policy_stale: "Workspace policy changed in another session. Refresh and try again."
  };
  return messages[code] ?? "Workspace policy could not be updated.";
}
