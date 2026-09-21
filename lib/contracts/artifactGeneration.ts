import { ARTIFACT_KINDS, ARTIFACT_LIMITS, normalizedArtifactPath, type ArtifactKind } from "./artifacts";
import { decodeThreadGeneratedArtifact, type ThreadGeneratedArtifact } from "./chats";

export const ARTIFACT_GENERATION_LIMITS = Object.freeze({ maxChunkChars: 8192, maxPreviewBytes: 2 * 1024 * 1024, maxDrafts: 32 });
type Identity = Readonly<{ draftId: string }>;
export type ArtifactGenerationEvent = Identity & (
  | Readonly<{ phase: "started" }>
  | Readonly<{ phase: "metadata"; title?: string; kind?: ArtifactKind }>
  /** Offsets count UTF-16 code units; a chunk never splits a surrogate pair. */
  | Readonly<{ phase: "file"; index: number; offset: number; text: string; path?: string }>
  | Readonly<{ phase: "reset" }>
  | Readonly<{ phase: "settled"; status: "ready"; artifact: ThreadGeneratedArtifact }>
  | Readonly<{ phase: "settled"; status: "failed" | "cancelled"; code?: string }>
);

export function decodeArtifactGenerationEvent(value: unknown): ArtifactGenerationEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.draftId !== "string" || !/^[A-Za-z0-9:_-]{1,160}$/u.test(input.draftId)) return null;
  const identity = { draftId: input.draftId };
  if (input.phase === "started" || input.phase === "reset") return { ...identity, phase: input.phase };
  if (input.phase === "metadata") {
    if (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim() || new TextEncoder().encode(input.title).byteLength > ARTIFACT_LIMITS.maxTitleBytes || /[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(input.title))) return null;
    if (input.kind !== undefined && !ARTIFACT_KINDS.includes(input.kind as ArtifactKind)) return null;
    return { ...identity, phase: "metadata", ...(typeof input.title === "string" ? { title: input.title } : {}),
      ...(input.kind !== undefined ? { kind: input.kind as ArtifactKind } : {}) };
  }
  if (input.phase === "file") {
    if (!Number.isSafeInteger(input.index) || Number(input.index) < 0 || Number(input.index) >= ARTIFACT_LIMITS.maxFiles ||
      !Number.isSafeInteger(input.offset) || Number(input.offset) < 0 || Number(input.offset) > ARTIFACT_LIMITS.maxTextFileBytes ||
      typeof input.text !== "string" || input.text.length > ARTIFACT_GENERATION_LIMITS.maxChunkChars || /[\uD800-\uDFFF]/u.test(input.text) ||
      input.path !== undefined && normalizedArtifactPath(input.path) !== input.path) return null;
    return { ...identity, phase: "file", index: Number(input.index), offset: Number(input.offset), text: input.text,
      ...(typeof input.path === "string" ? { path: input.path } : {}) };
  }
  if (input.phase === "settled") {
    if (input.status === "ready") {
      const artifact = decodeThreadGeneratedArtifact(input.artifact);
      return artifact ? { ...identity, phase: "settled", status: "ready", artifact } : null;
    }
    if (input.status !== "failed" && input.status !== "cancelled") return null;
    if (input.code !== undefined && (typeof input.code !== "string" || !/^[a-z][a-z0-9_]{0,95}$/u.test(input.code))) return null;
    return { ...identity, phase: "settled", status: input.status, ...(typeof input.code === "string" ? { code: input.code } : {}) };
  }
  return null;
}
