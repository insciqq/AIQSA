"use client";

import type { ChatSummary, FolderSummary, InspectorMode } from "@/components/app-shell/types";
import { useDialogFocus } from "@/components/app-shell/useDialogFocus";
import { useEventCallback } from "@/components/app-shell/useEventCallback";
import { useCallback, useEffect, useRef, useState } from "react";

const nonTextInputTypes = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit"
]);

export function isShellShortcutTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true;
  }

  if (target instanceof HTMLInputElement) {
    return !nonTextInputTypes.has(target.type);
  }

  for (let element: HTMLElement | null = target; element; element = element.parentElement) {
    if (element.isContentEditable || element.getAttribute("contenteditable") === "true") {
      return true;
    }
  }

  return false;
}

type ConfirmationController<Target> = {
  cancel(): void;
  confirm(): void;
  request(target: Target): Promise<boolean>;
  target: Target | null;
};

function useConfirmationController<Target>(): ConfirmationController<Target> {
  const [target, setTarget] = useState<Target | null>(null);
  const resolveRef = useRef<((confirmed: boolean) => void) | null>(null);

  const close = useCallback((confirmed: boolean) => {
    resolveRef.current?.(confirmed);
    resolveRef.current = null;
    setTarget(null);
  }, []);

  const request = useCallback((nextTarget: Target) => {
    resolveRef.current?.(false);
    setTarget(nextTarget);

    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const cancel = useCallback(() => close(false), [close]);
  const confirm = useCallback(() => close(true), [close]);

  return {
    cancel,
    confirm,
    request,
    target
  };
}

export type ShellOverlayControllerInput = Readonly<{
  appearance: Readonly<{
    changeMode(mode: InspectorMode): void;
    mode: InspectorMode;
  }>;
  blockers: Readonly<{
    projectSettingsOpen: boolean;
    settingsOpen: boolean;
  }>;
  onMobileWorkspaceClosed(): void;
}>;

export function useShellOverlayController({
  appearance,
  blockers,
  onMobileWorkspaceClosed
}: ShellOverlayControllerInput) {
  const { changeMode: changeAppearanceMode, mode: appearanceMode } = appearance;
  const { projectSettingsOpen, settingsOpen } = blockers;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileWorkspaceOpen, setMobileWorkspaceOpen] = useState(false);
  const chatConfirmation = useConfirmationController<ChatSummary>();
  const folderConfirmation = useConfirmationController<FolderSummary>();
  const messageConfirmation = useConfirmationController<string>();
  const onMobileWorkspaceClosedEvent = useEventCallback(onMobileWorkspaceClosed);

  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const showPalette = useCallback(() => setPaletteOpen(true), []);
  const showMobileWorkspace = useCallback(() => setMobileWorkspaceOpen(true), []);
  const closeMobileWorkspace = useCallback(() => {
    setMobileWorkspaceOpen(false);
    onMobileWorkspaceClosedEvent();
  }, [onMobileWorkspaceClosedEvent]);

  const mobileWorkspaceDialogRef = useDialogFocus<HTMLDivElement>({
    active: mobileWorkspaceOpen,
    onClose: closeMobileWorkspace,
    restoreFocus: () =>
      document.querySelector<HTMLElement>(
        '[data-testid="left-chat-pane"] button[aria-label="Start new chat"]'
      )
  });

  const confirmChat = useEventCallback(() => {
    chatConfirmation.confirm();
    if (mobileWorkspaceOpen) {
      closeMobileWorkspace();
    }
  });
  const confirmFolder = useEventCallback(() => {
    folderConfirmation.confirm();
    if (mobileWorkspaceOpen) {
      closeMobileWorkspace();
    }
  });

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        if (isShellShortcutTextEntryTarget(event.target)) {
          return;
        }

        const blockingModalOpen =
          mobileWorkspaceOpen ||
          projectSettingsOpen ||
          settingsOpen ||
          Boolean(chatConfirmation.target) ||
          Boolean(folderConfirmation.target) ||
          Boolean(messageConfirmation.target) ||
          false;
        if (blockingModalOpen) {
          return;
        }

        event.preventDefault();
        if (appearanceMode === "overlay") {
          changeAppearanceMode("closed");
          window.setTimeout(showPalette, 0);
          return;
        }
        showPalette();
      }

      if (event.key === "Escape" && paletteOpen) {
        event.preventDefault();
        closePalette();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    appearanceMode,
    chatConfirmation.target,
    changeAppearanceMode,
    closePalette,
    folderConfirmation.target,
    messageConfirmation.target,
    mobileWorkspaceOpen,
    paletteOpen,
    projectSettingsOpen,
    settingsOpen,
    showPalette
  ]);

  return {
    confirmations: {
      chat: {
        cancel: chatConfirmation.cancel,
        confirm: confirmChat,
        request: chatConfirmation.request,
        target: chatConfirmation.target
      },
      folder: {
        cancel: folderConfirmation.cancel,
        confirm: confirmFolder,
        request: folderConfirmation.request,
        target: folderConfirmation.target
      },
      message: messageConfirmation
    },
    mobileWorkspace: {
      close: closeMobileWorkspace,
      dialogRef: mobileWorkspaceDialogRef,
      open: mobileWorkspaceOpen,
      show: showMobileWorkspace
    },
    palette: {
      close: closePalette,
      open: paletteOpen,
      show: showPalette
    }
  };
}
