import type { AdminHealthRequestError } from "@/components/admin/health/adminHealthApi";
import {
  adminHealthRunLookupSearch,
  decodeAdminHealthRunLookupResponse,
  type AdminHealthRunLookupResponse
} from "@/lib/contracts/adminHealthRunLookup";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AdminHealthRunLookupResult =
  | Readonly<{ lookup: AdminHealthRunLookupResponse; ok: true }>
  | Readonly<{ error: AdminHealthRequestError; ok: false }>;

export type AdminHealthRunLookupRequest = (reference: string, signal?: AbortSignal) => Promise<AdminHealthRunLookupResult>;

/** `unavailable` covers a failed read, a malformed response and the network. */
export async function requestAdminHealthRunLookup(reference: string, signal?: AbortSignal,
  fetcher: Fetcher = fetch): Promise<AdminHealthRunLookupResult> {
  try {
    const response = await fetcher(`/api/admin/health/runs?${adminHealthRunLookupSearch(reference)}`, { method: "GET", signal });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = response.status === 401 ? "unauthorized" : response.status === 403 ? "forbidden"
        : response.status === 400 ? "invalid" : "unavailable";
      return { error, ok: false };
    }
    const lookup = decodeAdminHealthRunLookupResponse(data);
    return lookup ? { lookup, ok: true } : { error: "unavailable", ok: false };
  } catch {
    return { error: "unavailable", ok: false };
  }
}
