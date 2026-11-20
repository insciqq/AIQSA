import { create } from "zustand";

export type SavedArtifactPanelTarget = Readonly<{ chatId: string; artifactId: string; versionId: string; draftId?: never; file?: never }>;
/** A PDF or text file of an answer, previewed beside the chat like an artifact (operator request 2026-11-20). */
export type PanelFile = Readonly<{ attachmentId: string; byteSize: number; fileName: string; previewKind: "pdf" | "text" }>;
export type FileArtifactPanelTarget = Readonly<{ chatId: string; file: PanelFile; artifactId?: never; draftId?: never; versionId?: never }>;
export type ArtifactPanelTarget = SavedArtifactPanelTarget | FileArtifactPanelTarget |
  Readonly<{ chatId: string; draftId: string; artifactId?: never; versionId?: never; file?: never }>;

export const useArtifactPanelStore = create<{ open: ArtifactPanelTarget | null }>(() => ({ open: null }));

let sourceElement: HTMLElement | null = null;

export function focusArtifactPanel(): void {
  document.querySelector<HTMLElement>("[data-artifact-panel]")?.focus({ preventScroll: true });
}

export function openArtifactPanel(target: ArtifactPanelTarget, source?: HTMLElement | null): void {
  const previous = useArtifactPanelStore.getState().open;
  if (previous?.chatId === target.chatId && previous.draftId === target.draftId && previous.artifactId === target.artifactId &&
    previous.versionId === target.versionId && previous.file?.attachmentId === target.file?.attachmentId) {
    focusArtifactPanel();
    return;
  }
  sourceElement = source ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useArtifactPanelStore.setState({ open: target });
}

export function closeArtifactPanel(restoreFocus = true): void {
  const source = sourceElement;
  sourceElement = null;
  useArtifactPanelStore.setState({ open: null });
  if (restoreFocus && source?.isConnected) queueMicrotask(() => source.focus({ preventScroll: true }));
}

export function selectArtifactPanelVersion(versionId: string): void {
  const open = useArtifactPanelStore.getState().open;
  if (open?.artifactId !== undefined) useArtifactPanelStore.setState({ open: { ...open, versionId } });
}
