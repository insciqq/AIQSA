import { WORKSPACE_UPLOAD_MAX_BYTES, WORKSPACE_UPLOAD_PART_BYTES } from "@/lib/contracts/workspaceUploads";

export { WORKSPACE_UPLOAD_PART_BYTES };
export const WORKSPACE_UPLOAD_IDLE_MS = 15 * 60_000;
export const WORKSPACE_UPLOAD_LIFETIME_MS = 24 * 60 * 60_000;
export const WORKSPACE_UPLOAD_REQUEST_MS = 5 * 60_000;
// A writer's deadline is strictly shorter than its durable lease. Cleanup and
// retries cannot race an admitted writer even when its response was lost.
export const WORKSPACE_UPLOAD_LEASE_MS = 10 * 60_000;

export function workspaceUploadMaxBytes(env: Record<string, string | undefined> = process.env): number {
  const raw = env.AIQSA_WORKSPACE_UPLOAD_MAX_BYTES;
  if (raw === undefined || raw.trim() === "") return WORKSPACE_UPLOAD_MAX_BYTES;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > WORKSPACE_UPLOAD_MAX_BYTES) {
    throw new Error("workspace_upload_config_invalid");
  }
  return value;
}
