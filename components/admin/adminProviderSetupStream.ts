import {
  ADMIN_PROVIDER_SETUP_STREAM_TYPE,
  decodeAdminProviderSetupProgress,
  type AdminProviderSetupProgress
} from "@/lib/contracts/adminProviderSetupProgress";

/** The terminal payload still goes through the setup API's exact result decoder. */
export async function readAdminProviderSetupResponse(
  response: Response,
  onProgress?: (value: AdminProviderSetupProgress) => void
): Promise<{ ok: boolean; value: unknown }> {
  if (response.headers.get("content-type")?.split(";")[0] !== ADMIN_PROVIDER_SETUP_STREAM_TYPE) {
    return { ok: response.ok, value: await response.json().catch(() => null) };
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("provider_setup_interrupted");
  const decoder = new TextDecoder();
  let pending = "";
  let bytes = 0;
  try {
    for (;;) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("provider_setup_interrupted")), 45_000);
        })
      ]).finally(() => clearTimeout(timeout));
      if (done) throw new Error("provider_setup_interrupted");
      bytes += value.byteLength;
      if (bytes > 1_048_576) throw new Error("provider_setup_response_invalid");
      pending += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        if (end > 65_536) throw new Error("provider_setup_response_invalid");
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        const event: unknown = JSON.parse(line);
        if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("provider_setup_response_invalid");
        const record = event as Record<string, unknown>;
        const keys = Object.keys(record).sort().join(",");
        if (record.type === "heartbeat" && keys === "type") continue;
        if (record.type === "progress" && keys === "progress,type") {
          const progress = decodeAdminProviderSetupProgress(record.progress);
          if (!progress) throw new Error("provider_setup_response_invalid");
          onProgress?.(progress);
        } else if (record.type === "result" && keys === "data,status,type" &&
          Number.isInteger(record.status) && Number(record.status) >= 200 && Number(record.status) <= 599) {
          return { ok: Number(record.status) < 300, value: record.data };
        } else throw new Error("provider_setup_response_invalid");
      }
      if (pending.length > 65_536) throw new Error("provider_setup_response_invalid");
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
