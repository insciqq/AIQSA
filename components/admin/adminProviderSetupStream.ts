import {
  ADMIN_PROVIDER_SETUP_STREAM_TYPE,
  decodeAdminProviderSetupProgress,
  type AdminProviderSetupProgress
} from "@/lib/contracts/adminProviderSetupProgress";

export class AdminProviderSetupResponseError extends Error {
  constructor(readonly code: "provider_setup_response_invalid" | "provider_setup_response_too_large" |
    "provider_setup_interrupted" | "provider_setup_timeout") { super(code); }
}

export function adminProviderSetupFailureCode(error: unknown, signal?: AbortSignal | null): string {
  if (signal?.aborted || error instanceof DOMException && error.name === "AbortError") return "request_aborted";
  return error instanceof AdminProviderSetupResponseError ? error.code : "network_error";
}

function parse(text: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new AdminProviderSetupResponseError("provider_setup_response_invalid"); }
}

/** The terminal payload still goes through the setup API's exact result decoder. */
export async function readAdminProviderSetupResponse(
  response: Response,
  onProgress?: (value: AdminProviderSetupProgress) => void
): Promise<{ ok: boolean; status: number; value: unknown }> {
  const streaming = response.headers.get("content-type")?.split(";")[0] === ADMIN_PROVIDER_SETUP_STREAM_TYPE;
  const reader = response.body?.getReader();
  if (!reader) throw new AdminProviderSetupResponseError("provider_setup_interrupted");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let bytes = 0;
  try {
    for (;;) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new AdminProviderSetupResponseError("provider_setup_timeout")), 45_000);
        })
      ]).finally(() => clearTimeout(timeout));
      if (done) {
        if (streaming) throw new AdminProviderSetupResponseError("provider_setup_interrupted");
        try { pending += decoder.decode(); } catch { throw new AdminProviderSetupResponseError("provider_setup_response_invalid"); }
        return { ok: response.ok, status: response.status, value: parse(pending) };
      }
      bytes += value.byteLength;
      if (bytes > 1_048_576) throw new AdminProviderSetupResponseError("provider_setup_response_too_large");
      try { pending += decoder.decode(value, { stream: true }); }
      catch { throw new AdminProviderSetupResponseError("provider_setup_response_invalid"); }
      if (!streaming) continue;
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        if (end > 65_536) throw new AdminProviderSetupResponseError("provider_setup_response_too_large");
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        const event = parse(line);
        if (!event || typeof event !== "object" || Array.isArray(event)) throw new AdminProviderSetupResponseError("provider_setup_response_invalid");
        const record = event as Record<string, unknown>;
        const keys = Object.keys(record).sort().join(",");
        if (record.type === "heartbeat" && keys === "type") continue;
        if (record.type === "progress" && keys === "progress,type") {
          const progress = decodeAdminProviderSetupProgress(record.progress);
          if (!progress) throw new AdminProviderSetupResponseError("provider_setup_response_invalid");
          onProgress?.(progress);
        } else if (record.type === "result" && keys === "data,status,type" &&
          Number.isInteger(record.status) && Number(record.status) >= 200 && Number(record.status) <= 599) {
          return { ok: Number(record.status) < 300, status: Number(record.status), value: record.data };
        } else throw new AdminProviderSetupResponseError("provider_setup_response_invalid");
      }
      if (pending.length > 65_536) throw new AdminProviderSetupResponseError("provider_setup_response_too_large");
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
