import { decodeUploadAttachmentResponse, type UploadedAttachmentWire } from "./uploads";

export const WORKSPACE_UPLOAD_MAX_BYTES = 512 * 1024 * 1024;
export const WORKSPACE_UPLOAD_PART_BYTES = 8 * 1024 * 1024;
export const WORKSPACE_UPLOAD_MAX_PARTS = 64;

export type WorkspaceUploadConfigWire = Readonly<{
  maxBytes: number;
  ordinaryMaxBytes: number;
  partBytes: number;
  available: boolean;
}>;

export type WorkspaceUploadWire = Readonly<{
  id: string;
  byteSize: number;
  partBytes: number;
  completedParts: number[];
  state: "uploading" | "verifying" | "completed" | "cancelled" | "expired" | "failed";
  expiresAt: string;
  errorCode: string | null;
  attachment: UploadedAttachmentWire | null;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positive(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max;
}

export function decodeWorkspaceUploadConfig(value: unknown): WorkspaceUploadConfigWire | null {
  if (!record(value) || !positive(value.maxBytes, WORKSPACE_UPLOAD_MAX_BYTES) ||
    !positive(value.ordinaryMaxBytes, WORKSPACE_UPLOAD_MAX_BYTES) ||
    value.partBytes !== WORKSPACE_UPLOAD_PART_BYTES || typeof value.available !== "boolean") return null;
  return { maxBytes: value.maxBytes, ordinaryMaxBytes: value.ordinaryMaxBytes,
    partBytes: value.partBytes, available: value.available };
}

export function decodeWorkspaceUpload(value: unknown): WorkspaceUploadWire | null {
  if (!record(value) || typeof value.id !== "string" || !/^[a-zA-Z0-9-]{1,64}$/u.test(value.id) ||
    !positive(value.byteSize, WORKSPACE_UPLOAD_MAX_BYTES) || value.partBytes !== WORKSPACE_UPLOAD_PART_BYTES ||
    !Array.isArray(value.completedParts) || value.completedParts.length > WORKSPACE_UPLOAD_MAX_PARTS ||
    !value.completedParts.every(part => positive(part, Math.ceil(value.byteSize as number / WORKSPACE_UPLOAD_PART_BYTES))) ||
    new Set(value.completedParts).size !== value.completedParts.length ||
    !["uploading", "verifying", "completed", "cancelled", "expired", "failed"].includes(value.state as string) ||
    typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)) ||
    !(value.errorCode === null || typeof value.errorCode === "string" && /^[a-z_]{1,64}$/u.test(value.errorCode))) return null;
  const attachment = value.attachment === null ? null : decodeUploadAttachmentResponse({ attachment: value.attachment })?.attachment;
  if (attachment === undefined || (value.state === "completed" && !attachment) ||
    (value.state !== "completed" && attachment)) return null;
  return { id: value.id, byteSize: value.byteSize, partBytes: value.partBytes,
    completedParts: value.completedParts as number[], state: value.state as WorkspaceUploadWire["state"],
    expiresAt: value.expiresAt, errorCode: value.errorCode as string | null, attachment };
}
