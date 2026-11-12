import type { ContentBlock } from "../../../domain/content";

/**
 * Files the bridge hands to a Discord run go through the ordinary upload
 * route as the service account (a synthetic multipart request to the upload
 * handler in process, as Telegram's media does): a chat upload, never a
 * Workspace one, so no per-user Workspace slot can throttle every thread. A
 * busy process gate (429) is asked again with a growing pause; a file still
 * processing is waited for up to 90 s. The history file of a long thread
 * (`discord-history.md`) uses it now; attachments use it later (`dc-files`).
 */

export const DISCORD_UPLOAD_READY_TIMEOUT_MS = 90_000;
const UPLOAD_URL = "http://localhost/api/uploads";
const UPLOAD_BUSY_ATTEMPTS = 4;
const READY_POLL_FIRST_MS = 250;
const READY_POLL_MAX_MS = 3_000;

export type DiscordUploadServices = Readonly<{
  /** The upload route's handler in process, as the service account. */
  upload(input: Readonly<{ request: Request; userId: string }>): Promise<Response>;
  /** The account's own attachment's status; null when it is not theirs or gone. */
  attachmentStatus(input: Readonly<{ attachmentId: string; userId: string }>): Promise<string | null>;
}>;

export type DiscordUploadResult =
  | Readonly<{ ok: true; block: ContentBlock }>
  | Readonly<{ ok: false; code: string }>;

export type DiscordUploads = Readonly<{
  uploadFile(input: Readonly<{ userId: string; fileName: string; mimeType: string; data: Uint8Array }>): Promise<DiscordUploadResult>;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function createDiscordUploads(deps: Readonly<{
  services: () => Promise<DiscordUploadServices>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readyTimeoutMs?: number;
}>): DiscordUploads {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); }));
  const readyTimeoutMs = deps.readyTimeoutMs ?? DISCORD_UPLOAD_READY_TIMEOUT_MS;

  async function settled(services: DiscordUploadServices, userId: string, attachmentId: string, status: string): Promise<boolean> {
    if (status === "ready") return true;
    if (status !== "processing") return false;
    const deadline = now() + readyTimeoutMs;
    for (let pause = READY_POLL_FIRST_MS; ; pause = Math.min(pause * 2, READY_POLL_MAX_MS)) {
      await sleep(Math.max(0, Math.min(pause, deadline - now())));
      const current = await services.attachmentStatus({ attachmentId, userId });
      if (current === "ready") return true;
      if (current !== "processing" || now() >= deadline) return false;
    }
  }

  return Object.freeze({
    async uploadFile(input) {
      const services = await deps.services();
      for (let attempt = 1; ; attempt += 1) {
        const form = new FormData();
        form.set("file", new File([new Uint8Array(input.data)], input.fileName, { type: input.mimeType }));
        const response = await services.upload({ request: new Request(UPLOAD_URL, { body: form, method: "POST" }), userId: input.userId });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          if (response.status === 429 && attempt < UPLOAD_BUSY_ATTEMPTS) {
            await sleep(1_000 * 2 ** (attempt - 1));
            continue;
          }
          const code = record(body)?.error;
          return { code: typeof code === "string" && code ? code.slice(0, 80) : `http_${response.status}`, ok: false };
        }
        const attachment = record(record(body)?.attachment);
        const id = attachment?.id;
        const kind = attachment?.kind;
        const status = attachment?.status;
        if (typeof id !== "string" || !id || typeof status !== "string") return { code: "discord_upload_failed", ok: false };
        if (!await settled(services, input.userId, id, status)) return { code: "discord_upload_failed", ok: false };
        const fileName = typeof attachment?.fileName === "string" ? attachment.fileName : input.fileName;
        return {
          block: kind === "image" ? { alt: fileName, attachmentId: id, type: "image" } : { attachmentId: id, fileName, type: "file" },
          ok: true
        };
      }
    }
  });
}
