import {
  adminHealthIncidentSearch,
  decodeAdminHealthIncidentsResponse,
  decodeAdminHealthResponse,
  type AdminHealth,
  type AdminHealthIncidentFilters,
  type AdminHealthIncidentsResponse,
  type AdminHealthRange
} from "@/lib/contracts/adminHealth";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** `unavailable` covers a failed read, a malformed response and the network; `invalid` a rejected query. */
export type AdminHealthRequestError = "forbidden" | "invalid" | "unauthorized" | "unavailable";

export type AdminHealthResult =
  | Readonly<{ health: AdminHealth; ok: true }>
  | Readonly<{ error: AdminHealthRequestError; ok: false }>;

export type AdminHealthIncidentsResult =
  | Readonly<{ ok: true; page: AdminHealthIncidentsResponse }>
  | Readonly<{ error: AdminHealthRequestError; ok: false }>;

function errorOf(status: number, data: unknown): AdminHealthRequestError {
  const code = typeof data === "object" && data !== null && "error" in data ? (data as { error: unknown }).error : null;
  if (status === 401 || code === "unauthorized") return "unauthorized";
  if (status === 403 || code === "forbidden") return "forbidden";
  if (status === 400 || code === "admin_health_query_invalid") return "invalid";
  return "unavailable";
}

async function read<T>(fetcher: Fetcher, path: string, decode: (value: unknown) => T | null, signal?: AbortSignal):
  Promise<Readonly<{ ok: true; value: T }> | Readonly<{ error: AdminHealthRequestError; ok: false }>> {
  try {
    const response = await fetcher(path, { method: "GET", signal });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) return { error: errorOf(response.status, data), ok: false };
    const decoded = decode(data);
    return decoded ? { ok: true, value: decoded } : { error: "unavailable", ok: false };
  } catch {
    return { error: "unavailable", ok: false };
  }
}

export async function requestAdminHealth(range: AdminHealthRange, signal?: AbortSignal, fetcher: Fetcher = fetch): Promise<AdminHealthResult> {
  const result = await read(fetcher, `/api/admin/health?range=${encodeURIComponent(range)}`, decodeAdminHealthResponse, signal);
  return result.ok ? { health: result.value.health, ok: true } : result;
}

export async function requestAdminHealthIncidents(filters: AdminHealthIncidentFilters, signal?: AbortSignal,
  fetcher: Fetcher = fetch): Promise<AdminHealthIncidentsResult> {
  const result = await read(fetcher, `/api/admin/health/incidents?${adminHealthIncidentSearch(filters)}`,
    decodeAdminHealthIncidentsResponse, signal);
  return result.ok ? { ok: true, page: result.value } : result;
}
