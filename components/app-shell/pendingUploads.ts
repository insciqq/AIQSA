import { create } from "zustand";
import { randomUUID } from "@/lib/browser/randomUUID";
import { useComposerSessionStore, type ComposerSessionKey } from "./composerSessionStore";
import { trackUploadProgress, untrackUploadProgress, useWorkspaceUploadProgress } from "./workspaceUploadClient";

/** Larger images keep the plain file icon instead of a decoded thumbnail. */
const PREVIEW_MAX_BYTES = 20 * 1024 * 1024;
const PREVIEW_TYPES: ReadonlySet<string> = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

export type PendingUpload = Readonly<{
  file: File;
  id: string;
  /** Aborted when the user removes the row before its upload settles. */
  signal: AbortSignal;
}>;

/**
 * Lists chosen files in their composer tray at once, before any request: an
 * upload that waits for settings, verification or the network never leaves
 * the composer looking unchanged. Each row leaves the tray when its upload
 * settles (`releasePendingUpload`) or the user removes it.
 */
export function trackPendingUploads(sourceKey: ComposerSessionKey, files: readonly File[]): PendingUpload[] {
  return files.map((file) => {
    const id = `upload-${randomUUID()}`;
    const controller = new AbortController();
    trackUploadProgress({
      byteSize: file.size, fileName: file.name, id, message: null, retryable: false, sentBytes: 0, sourceKey,
      state: "uploading"
    }, {
      cancel() {
        controller.abort();
        untrackUploadProgress(id);
      },
      retry() {}
    });
    createUploadPreview(id, file);
    return { file, id, signal: controller.signal };
  });
}

export function releasePendingUpload(upload: PendingUpload): void {
  if (useWorkspaceUploadProgress.getState().items.some((item) => item.id === upload.id)) untrackUploadProgress(upload.id);
}

/**
 * Thumbnails of images the user just chose, made from the local file. They
 * live only in this tab while the file sits in a composer tray (keyed by its
 * pending row, then by the attachment its upload created) and are never
 * stored or sent anywhere.
 */
export const useUploadPreviews = create<{ urls: Readonly<Record<string, string>> }>(() => ({ urls: {} }));

let stopWatching: (() => void) | null = null;
let retainTimer: ReturnType<typeof setTimeout> | null = null;

function retainListedPreviews(): void {
  retainTimer = null;
  const { urls } = useUploadPreviews.getState();
  const ids = Object.keys(urls);
  if (ids.length === 0) return;
  const listed = new Set(useWorkspaceUploadProgress.getState().items.map((item) => item.id));
  for (const session of Object.values(useComposerSessionStore.getState().sessionsByKey)) {
    for (const attachment of session?.attachments ?? []) listed.add(attachment.id);
  }
  const released = ids.filter((id) => !listed.has(id));
  if (released.length === 0) return;
  const next = { ...urls };
  for (const id of released) {
    URL.revokeObjectURL(next[id]!);
    delete next[id];
  }
  useUploadPreviews.setState({ urls: next });
}

/** A file that leaves every tray (sent, removed, cancelled, failed) frees its
 * thumbnail. The check waits a task so a settling upload can hand its
 * thumbnail to the attachment that replaces its row. */
function scheduleRetain(): void {
  retainTimer ??= setTimeout(retainListedPreviews, 0);
}

function createUploadPreview(id: string, file: File): void {
  if (!PREVIEW_TYPES.has(file.type) || file.size > PREVIEW_MAX_BYTES || typeof URL.createObjectURL !== "function") return;
  if (!stopWatching) {
    const stopSessions = useComposerSessionStore.subscribe(scheduleRetain);
    const stopUploads = useWorkspaceUploadProgress.subscribe(scheduleRetain);
    stopWatching = () => {
      stopSessions();
      stopUploads();
    };
  }
  const url = URL.createObjectURL(file);
  useUploadPreviews.setState((state) => ({ urls: { ...state.urls, [id]: url } }));
}

/** The attachment a settled upload created keeps the thumbnail of its pending row. */
export function moveUploadPreview(fromId: string, toId: string): void {
  const { urls } = useUploadPreviews.getState();
  const url = urls[fromId];
  if (!url || fromId === toId) return;
  const next = { ...urls, [toId]: url };
  delete next[fromId];
  useUploadPreviews.setState({ urls: next });
}

export function resetPendingUploadsForTest(): void {
  stopWatching?.();
  stopWatching = null;
  if (retainTimer !== null) clearTimeout(retainTimer);
  retainTimer = null;
  for (const url of Object.values(useUploadPreviews.getState().urls)) URL.revokeObjectURL(url);
  useUploadPreviews.setState({ urls: {} });
  for (const item of useWorkspaceUploadProgress.getState().items) untrackUploadProgress(item.id);
}
