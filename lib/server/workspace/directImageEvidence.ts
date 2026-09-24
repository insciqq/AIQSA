import { WorkspaceImageError, type WorkspaceImageDescriptor } from "./imageCapture";
import { isSafeWorkspaceRelativePath, isWorkspaceOpaqueId } from "@/lib/domain/workspace";

export type WorkspaceImageEvidence = Readonly<{ consumerKey: string; descriptor: WorkspaceImageDescriptor }>;
const record = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const positive = (v: unknown, max: number) => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= max;
const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
export function parseWorkspaceImageEvidence(value: unknown): WorkspaceImageEvidence | null {
  if (!record(value) || Object.keys(value).some(k => !["consumerKey", "descriptor"].includes(k)) || typeof value.consumerKey !== "string" || !isWorkspaceOpaqueId(value.consumerKey)) return null;
  const d = value.descriptor;
  if (!record(d) || Object.keys(d).some(k => !["version", "id", "byteSize", "checksum", "mimeType", "width", "height", "frames", "source", "transform"].includes(k)) ||
    d.version !== 1 || !hash(d.id) || !hash(d.checksum) || !positive(d.byteSize, 24 * 1024 * 1024) ||
    !["image/png", "image/jpeg"].includes(String(d.mimeType)) || !positive(d.width, 16384) || !positive(d.height, 16384) || d.frames !== 1) return null;
  const s = d.source;
  if (!record(s) || Object.keys(s).some(k => !["captureId", "relativePath", "byteSize", "checksum", "width", "height"].includes(k)) ||
    typeof s.captureId !== "string" || !/^[a-f0-9]{32}$/u.test(s.captureId) || typeof s.relativePath !== "string" || !isSafeWorkspaceRelativePath(s.relativePath) ||
    !/^(inbox|project|output)\//u.test(String(s.relativePath)) || !hash(s.checksum) || !positive(s.byteSize, 24 * 1024 * 1024) ||
    !positive(s.width, 16384) || !positive(s.height, 16384)) return null;
  if (d.transform !== null) {
    const t = d.transform;
    if (!record(t) || !Object.keys(t).length || Object.keys(t).some(k => !["crop", "resize"].includes(k))) return null;
    for (const name of ["crop", "resize"] as const) {
      if (t[name] === undefined) continue;
      const box = t[name];
      if (!record(box) || Object.keys(box).some(k => !(name === "crop" ? ["left", "top", "width", "height"] : ["width", "height"]).includes(k)) ||
        !positive(box.width, 16384) || !positive(box.height, 16384) || name === "crop" &&
        (![box.left, box.top].every(v => Number.isSafeInteger(v) && Number(v) >= 0))) return null;
    }
  }
  return value as unknown as WorkspaceImageEvidence;
}

/** Reserve visual input cost before history packing, without encoding private pixels. */
export function workspaceImageTokenReserve(messages: readonly unknown[] | undefined): number {
  let total = 0;
  for (const message of messages ?? []) {
    if (!record(message) || message.type !== "function_call_output" || !Array.isArray(message.output)) continue;
    for (const part of message.output) {
      if (!record(part) || part.type !== "workspace_image") continue;
      const evidence = parseWorkspaceImageEvidence(part.value);
      if (!evidence) throw new WorkspaceImageError("workspace_image_invalid");
      const d = evidence.descriptor;
      total += Math.ceil(d.width / 32) * Math.ceil(d.height / 32) * 4 + 1024;
    }
  }
  return total;
}
