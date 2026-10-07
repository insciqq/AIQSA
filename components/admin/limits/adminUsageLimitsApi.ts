import {
  decodeAdminUsageLimitsResponse,
  type AdminUsageGroupLimitsInput,
  type AdminUsageInstallationLimitsInput,
  type AdminUsageLimits,
  type AdminUsageUserLimitsInput
} from "@/lib/contracts/usageLimits";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AdminUsageLimitsResult =
  | Readonly<{ limits: AdminUsageLimits; ok: true }>
  | Readonly<{ error: string; ok: false }>;

const BASE = "/api/admin/usage-limits";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every answer carries the whole view; a malformed one is an error, never guessed state. */
async function send(path: string, init: RequestInit, fetcher: Fetcher): Promise<AdminUsageLimitsResult> {
  try {
    const response = await fetcher(path, { cache: "no-store", credentials: "same-origin", ...init });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      return { error: isRecord(value) && typeof value.error === "string" ? value.error : "usage_limits_action_failed", ok: false };
    }
    const decoded = decodeAdminUsageLimitsResponse(value);
    return decoded ? { limits: decoded.limits, ok: true } : { error: "usage_limits_response_invalid", ok: false };
  } catch {
    return { error: "network_error", ok: false };
  }
}

function json(method: "PATCH" | "PUT", body: unknown, signal?: AbortSignal): RequestInit {
  return { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method, signal };
}

/** A first save sends no version: it expects nothing saved yet. */
function versioned<T extends Readonly<{ expectedVersion: number | null }>>({ expectedVersion, ...rest }: T) {
  return expectedVersion === null ? rest : { ...rest, expectedVersion };
}

export function requestAdminUsageLimits(signal?: AbortSignal, fetcher: Fetcher = fetch): Promise<AdminUsageLimitsResult> {
  return send(BASE, { method: "GET", signal }, fetcher);
}

export function saveInstallationUsageLimits(
  input: AdminUsageInstallationLimitsInput,
  fetcher: Fetcher = fetch
): Promise<AdminUsageLimitsResult> {
  return send(`${BASE}/installation`, json("PATCH", input), fetcher);
}

export function saveGroupUsageLimits(
  groupId: string,
  input: AdminUsageGroupLimitsInput,
  fetcher: Fetcher = fetch
): Promise<AdminUsageLimitsResult> {
  return send(`${BASE}/groups/${encodeURIComponent(groupId)}`, json("PUT", versioned(input)), fetcher);
}

export function saveUserUsageLimits(
  userId: string,
  input: AdminUsageUserLimitsInput,
  fetcher: Fetcher = fetch
): Promise<AdminUsageLimitsResult> {
  return send(`${BASE}/users/${encodeURIComponent(userId)}`, json("PUT", versioned(input)), fetcher);
}

/** Removes the override saved at `expectedVersion`; a newer one answers `usage_limits_stale`. */
export function removeUserUsageLimits(
  userId: string,
  expectedVersion: number | null,
  fetcher: Fetcher = fetch
): Promise<AdminUsageLimitsResult> {
  const query = expectedVersion === null ? "" : `?expectedVersion=${expectedVersion}`;
  return send(`${BASE}/users/${encodeURIComponent(userId)}${query}`, { method: "DELETE" }, fetcher);
}

export function usageLimitsErrorMessage(code: string): string {
  switch (code) {
    case "usage_limits_stale":
      return "Limits changed in another session. Your edits were kept; check the saved values and save again.";
    case "group_not_found":
      return "This group no longer exists. Close this panel to see the current groups.";
    case "user_not_found":
      return "This user no longer exists. Close this panel to see the current users.";
    case "usage_limits_input_invalid":
      return "Some values are outside the allowed range. Check them and try again.";
    case "forbidden":
    case "unauthorized":
      return "Your session can no longer manage budgets and limits. Sign in again as an administrator.";
    case "network_error":
      return "Budgets and limits could not be reached. Check the connection and try again.";
    default:
      return "Budgets and limits are unavailable right now. Try again.";
  }
}
