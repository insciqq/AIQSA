import {
  decodeAdminAttentionResponse,
  type AdminAttention
} from "@/lib/contracts/adminAttention";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AdminAttentionResult =
  | Readonly<{ attention: AdminAttention; ok: true }>
  | Readonly<{ error: "admin_attention_failed" | "forbidden" | "network_error" | "unauthorized"; ok: false }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function requestAdminAttention(fetcher: Fetcher = fetch): Promise<AdminAttentionResult> {
  try {
    const response = await fetcher("/api/admin/attention", { method: "GET" });
    const data: unknown = await response.json().catch(() => null);
    if (response.ok) {
      const decoded = decodeAdminAttentionResponse(data);
      return decoded
        ? { attention: decoded.attention, ok: true }
        : { error: "admin_attention_failed", ok: false };
    }
    const error = isRecord(data) && (data.error === "forbidden" || data.error === "unauthorized")
      ? data.error
      : "admin_attention_failed";
    return { error, ok: false };
  } catch {
    return { error: "network_error", ok: false };
  }
}
