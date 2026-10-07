import {
  adminUsageQuery,
  decodeAdminUsageAnalyticsResponse,
  type AdminUsageAnalytics,
  type AdminUsagePeriod
} from "@/lib/contracts/adminUsageAnalytics";

export type AdminUsageAnalyticsResult =
  | { ok: true; usage: AdminUsageAnalytics }
  | { error: string; ok: false };

export function adminUsageExportHref(period: AdminUsagePeriod, timeZone: string): string {
  return `/api/admin/usage/export?${adminUsageQuery(period, timeZone)}`;
}

export async function requestAdminUsageAnalytics(
  input: Readonly<{ period: AdminUsagePeriod; signal?: AbortSignal; timeZone: string }>,
  fetcher: typeof fetch = fetch
): Promise<AdminUsageAnalyticsResult> {
  try {
    const response = await fetcher(`/api/admin/usage?${adminUsageQuery(input.period, input.timeZone)}`, {
      cache: "no-store",
      credentials: "same-origin",
      method: "GET",
      signal: input.signal
    });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = typeof value === "object" && value !== null && "error" in value &&
        typeof value.error === "string" ? value.error : "usage_analytics_failed";
      return { error, ok: false };
    }
    const decoded = decodeAdminUsageAnalyticsResponse(value);
    return decoded ? { ok: true, usage: decoded.usage } : { error: "usage_analytics_malformed", ok: false };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return { error: "network_error", ok: false };
  }
}

export function adminUsageErrorMessage(code: string): string {
  switch (code) {
    case "unauthorized":
    case "forbidden":
      return "Your session can no longer view usage. Sign in again as an administrator.";
    case "usage_time_zone_invalid":
      return "This browser reports a time zone the server does not recognize, so usage could not be grouped by day.";
    case "usage_period_invalid":
      return "This period is not available. Choose another period.";
    case "network_error":
      return "Usage could not be reached. Check the connection and try again.";
    default:
      return "Usage could not be loaded. Try again.";
  }
}
