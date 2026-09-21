import { ARTIFACT_GENERATION_LIMITS, type ArtifactGenerationEvent } from "@/lib/contracts/artifactGeneration";
import { ARTIFACT_LIMITS, type ArtifactKind } from "@/lib/contracts/artifacts";
import type { ThreadGeneratedArtifact } from "@/lib/contracts/chats";

export type ArtifactGenerationFile = Readonly<{ index: number; path?: string; text: string; byteSize: number }>;
export type ArtifactGenerationDraft = Readonly<{
  draftId: string;
  title?: string;
  kind?: ArtifactKind;
  status: "pending" | "ready" | "failed" | "cancelled" | "interrupted";
  files: readonly ArtifactGenerationFile[];
  previewUnavailable?: boolean;
  artifact?: ThreadGeneratedArtifact;
}>;

const encoder = new TextEncoder();

/** Transient, bounded text only. Saved versions and their authenticated content remain authoritative. */
export function applyArtifactGenerationEvent(
  drafts: readonly ArtifactGenerationDraft[], event: ArtifactGenerationEvent
): readonly ArtifactGenerationDraft[] {
  const previous = drafts.find(draft => draft.draftId === event.draftId);
  if (!previous && event.phase !== "started" || !previous && drafts.length >= ARTIFACT_GENERATION_LIMITS.maxDrafts) return drafts;
  if (previous && previous.status !== "pending") return drafts;
  let next: ArtifactGenerationDraft = previous ?? { draftId: event.draftId, status: "pending", files: [] };
  if (event.phase === "metadata") next = { ...next, ...event.title && { title: event.title }, ...event.kind && { kind: event.kind } };
  if (event.phase === "reset") next = { ...next, files: [], previewUnavailable: false };
  if (event.phase === "file" && !next.previewUnavailable) {
    const file = next.files.find(file => file.index === event.index);
    const text = (file?.text ?? "") + event.text;
    const byteSize = encoder.encode(text).byteLength;
    const total = drafts.reduce((sum, draft) => sum + draft.files.reduce((sum, file) => sum + file.byteSize, 0), 0);
    if (event.offset !== (file?.text.length ?? 0) || event.index >= ARTIFACT_LIMITS.maxFiles ||
      byteSize > ARTIFACT_LIMITS.maxTextFileBytes || total - (file?.byteSize ?? 0) + byteSize > ARTIFACT_GENERATION_LIMITS.maxPreviewBytes) {
      next = { ...next, files: [], previewUnavailable: true };
    } else {
      const updated = { index: event.index, path: event.path ?? file?.path, text, byteSize };
      next = { ...next, files: [...next.files.filter(file => file.index !== event.index), updated].sort((a, b) => a.index - b.index) };
    }
  }
  if (event.phase === "settled") next = { ...next, status: event.status, files: [],
    ...event.status === "ready" && { artifact: event.artifact } };
  return previous ? drafts.map(draft => draft.draftId === next.draftId ? next : draft) : [...drafts, next];
}

export function endArtifactGeneration(drafts: readonly ArtifactGenerationDraft[], status: "complete" | "error" | "cancelled" | "interrupted") {
  return drafts.map(draft => draft.status !== "pending" && !(draft.status === "interrupted" && (status === "cancelled" || status === "error")) ? draft : { ...draft, files: [],
    status: status === "cancelled" ? "cancelled" as const : status === "error" ? "failed" as const : "interrupted" as const });
}

export function artifactGenerationStatus(draft: ArtifactGenerationDraft): string {
  if (draft.status === "failed") return "Artifact wasn’t created. See the run details for the reason.";
  if (draft.status === "cancelled") return "Artifact wasn’t created. Creation was stopped.";
  if (draft.status === "interrupted") return "Live code is unavailable. Refresh the conversation to check the saved result.";
  if (draft.previewUnavailable) return "Creating artifact… Live code is unavailable.";
  return "Creating artifact…";
}
