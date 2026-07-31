import {
  decodeAdminReleaseStatus,
  type AdminReleaseStatus
} from "@/lib/contracts/adminRelease";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AdminReleaseStatusResult =
  | Readonly<{ ok: true; status: AdminReleaseStatus }>
  | Readonly<{ ok: false }>;

export async function requestAdminReleaseStatus(
  fetcher: Fetcher = fetch
): Promise<AdminReleaseStatusResult> {
  try {
    const response = await fetcher("/api/admin/release", { method: "GET" });
    const data = await response.json().catch(() => null);
    const status = response.ok ? decodeAdminReleaseStatus(data) : null;
    return status ? { ok: true, status } : { ok: false };
  } catch {
    return { ok: false };
  }
}
