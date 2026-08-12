"use client";

import { DiscardChangesConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { MemorySettingsSection } from "@/components/app-shell/MemorySettingsSection";
import { ShellNotice } from "@/components/app-shell/ShellNotice";
import { discardMemoryManagerDraft } from "@/components/app-shell/memoryManagerStore";
import type { Notice } from "@/components/app-shell/types";
import { useBeforeUnloadGuard } from "@/components/app-shell/useBeforeUnloadGuard";
import { useDialogFocus } from "@/components/app-shell/useDialogFocus";
import { ArrowLeft, Brain } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app-canvas";
const backButton =
  `inline-flex min-h-touch shrink-0 items-center justify-center gap-2 rounded-control px-3 text-xs font-medium text-ink-secondary hover:bg-control-hover hover:text-ink disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-60 sm:min-h-control-sm [@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch ${focusRing}`;

export function MemoryWorkspace({
  accountId,
  notice = null,
  onClose,
  onDismissNotice,
  onOpenMemorySource,
  restoreFocus
}: Readonly<{
  accountId: string;
  notice?: Notice | null;
  onClose(): void;
  onDismissNotice?(): void;
  onOpenMemorySource(chatId: string): void;
  restoreFocus?(): HTMLElement | null;
}>) {
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const backRef = useRef<HTMLButtonElement>(null);
  useBeforeUnloadGuard(dirty);

  const requestClose = () => {
    if (busy) return;
    if (dirty) {
      setDiscardOpen(true);
      return;
    }
    onClose();
  };
  const workspaceRef = useDialogFocus<HTMLDivElement>({
    autoFocus: false,
    closeOnEscape: !discardOpen && !busy,
    containFocus: !discardOpen,
    onClose: requestClose,
    restoreFocus
  });

  useEffect(() => {
    if (discardOpen) return;
    const timer = window.setTimeout(() => backRef.current?.focus({ preventScroll: true }), 0);
    return () => window.clearTimeout(timer);
  }, [discardOpen]);

  return (
    <>
      <div
        ref={workspaceRef}
        aria-busy={busy || undefined}
        aria-hidden={discardOpen || undefined}
        aria-label="Memory"
        aria-modal="true"
        className="fixed inset-0 z-50 flex h-[100dvh] w-full flex-col overflow-hidden bg-app-canvas pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] text-ink"
        data-testid="memory-workspace"
        inert={discardOpen || undefined}
        role="dialog"
      >
        <header className="shrink-0 border-b border-trace-subtle bg-app-canvas px-3 py-3 sm:px-6 lg:px-8">
          <div className="mx-auto grid w-full max-w-6xl min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
            <button ref={backRef} className={backButton} disabled={busy} onClick={requestClose} type="button">
              <ArrowLeft className="size-4" aria-hidden="true" />
              Back to chat
            </button>
            <div className="flex min-w-0 items-center gap-3">
              <span className="hidden size-8 shrink-0 place-items-center rounded-control bg-control-selected text-proof sm:grid" aria-hidden="true">
                <Brain className="size-4" />
              </span>
              <div className="min-w-0">
                <h1 className="truncate text-xl font-semibold tracking-tight text-ink">Memory</h1>
                <p className="mt-0.5 hidden truncate text-xs text-ink-muted sm:block">
                  Control what AIQSA remembers, inspect saved context, and review advanced evidence when needed.
                </p>
              </div>
            </div>
          </div>
        </header>

        {notice ? (
          <div
            className="relative z-10 flex shrink-0 justify-center border-b border-trace-subtle bg-app-canvas px-3 py-2"
            data-testid="memory-notice-region"
          >
            <ShellNotice notice={notice} onDismiss={onDismissNotice ?? (() => undefined)} />
          </div>
        ) : null}

        <MemorySettingsSection
          accountId={accountId}
          onBusyChange={setBusy}
          onDirtyChange={setDirty}
          onOpenMemorySource={onOpenMemorySource}
        />
      </div>

      {discardOpen ? (
        <DiscardChangesConfirmationDialog
          label="Memory draft"
          onCancel={() => setDiscardOpen(false)}
          onConfirm={() => {
            discardMemoryManagerDraft();
            setDirty(false);
            setDiscardOpen(false);
            onClose();
          }}
        />
      ) : null}
    </>
  );
}
