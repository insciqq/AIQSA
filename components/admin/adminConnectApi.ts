import {
  CONNECT_ADMIN_POLICY_CONFLICT_ERROR,
  CONNECT_ADMIN_POLICY_PATH,
  decodeConnectAdminPolicyResponse,
  type ConnectAdminPolicy
} from "@/lib/contracts/connect";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AdminConnectResult =
  | Readonly<{ data: ConnectAdminPolicy; ok: true }>
  | Readonly<{ error: string; ok: false }>;

async function request(init: RequestInit, fetcher: Fetcher): Promise<AdminConnectResult> {
  try {
    const response = await fetcher(CONNECT_ADMIN_POLICY_PATH, {
      cache: "no-store",
      credentials: "same-origin",
      ...init
    });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = typeof value === "object" && value !== null &&
        typeof (value as Record<string, unknown>).error === "string"
        ? String((value as Record<string, unknown>).error)
        : response.status === 401 ? "unauthorized" : response.status === 403 ? "forbidden" : "connect_policy_failed";
      return { error, ok: false };
    }
    const decoded = decodeConnectAdminPolicyResponse(value);
    return decoded ? { data: decoded.connect, ok: true } : { error: "connect_policy_response_invalid", ok: false };
  } catch {
    return { error: "network_error", ok: false };
  }
}

export function getAdminConnectPolicy(fetcher: Fetcher = fetch, signal?: AbortSignal): Promise<AdminConnectResult> {
  return request({ method: "GET", ...(signal ? { signal } : {}) }, fetcher);
}

export function updateAdminConnectPolicy(
  input: Readonly<{ enabled: boolean; expectedVersion: number }>,
  fetcher: Fetcher = fetch
): Promise<AdminConnectResult> {
  return request({
    body: JSON.stringify({ enabled: input.enabled, expectedVersion: input.expectedVersion }),
    headers: { "content-type": "application/json" },
    method: "PATCH"
  }, fetcher);
}

export function adminConnectErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    [CONNECT_ADMIN_POLICY_CONFLICT_ERROR]: "AIQSA Connect was changed in another session. The current setting is shown; try again.",
    connect_policy_failed: "The AIQSA Connect setting could not be loaded.",
    connect_policy_response_invalid: "The AIQSA Connect setting response was invalid.",
    forbidden: "Your account can no longer manage AIQSA Connect.",
    network_error: "The AIQSA Connect setting could not be reached.",
    unauthorized: "Your administrator session has expired. Sign in again to continue."
  };
  return messages[code] ?? "The AIQSA Connect setting could not be updated.";
}
