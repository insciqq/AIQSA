"use client";

import type { WorkspaceChatSummary, FolderSummary } from "@/components/app-shell/types";
import { useCallback, useRef, useState } from "react";

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

export function useShellOverlayController() {
  const [branchesOpen, setBranchesOpen] = useState(false);
  const chatConfirmation = useConfirmationController<WorkspaceChatSummary>();
  const folderConfirmation = useConfirmationController<FolderSummary>();
  const messageConfirmation = useConfirmationController<string>();

  const closeBranches = useCallback(() => setBranchesOpen(false), []);
  const showBranches = useCallback(() => setBranchesOpen(true), []);

  return {
    branches: {
      close: closeBranches,
      open: branchesOpen,
      show: showBranches
    },
    confirmations: {
      chat: {
        cancel: chatConfirmation.cancel,
        confirm: chatConfirmation.confirm,
        request: chatConfirmation.request,
        target: chatConfirmation.target
      },
      folder: {
        cancel: folderConfirmation.cancel,
        confirm: folderConfirmation.confirm,
        request: folderConfirmation.request,
        target: folderConfirmation.target
      },
      message: messageConfirmation
    }
  };
}
