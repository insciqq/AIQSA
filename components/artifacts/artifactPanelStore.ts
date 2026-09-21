import { create } from "zustand";

export type SavedArtifactPanelTarget = Readonly<{ chatId: string; artifactId: string; versionId: string; draftId?: never }>;
export type ArtifactPanelTarget = SavedArtifactPanelTarget | Readonly<{ chatId: string; draftId: string; artifactId?: never; versionId?: never }>;

export const useArtifactPanelStore = create<{ open: ArtifactPanelTarget | null }>(() => ({ open: null }));

let sourceElement: HTMLElement | null = null;

export function focusArtifactPanel(): void {
  document.querySelector<HTMLElement>("[data-artifact-panel]")?.focus({ preventScroll: true });
}

export function openArtifactPanel(target: ArtifactPanelTarget, source?: HTMLElement | null): void {
  const previous = useArtifactPanelStore.getState().open;
  if (previous?.chatId === target.chatId && previous.draftId === target.draftId && previous.artifactId === target.artifactId && previous.versionId === target.versionId) {
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
