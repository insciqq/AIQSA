import { DiscardChangesConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import type { FolderSummary } from "@/components/app-shell/types";
import { X } from "lucide-react";
import { useState } from "react";
import { useDialogFocus } from "./useDialogFocus";

export function ProjectSettingsDialog({
  folder,
  memoryDraft,
  onCancel,
  onMemoryDraftChange,
  onSave,
  restoreFocus,
  saving
}: {
  folder: FolderSummary;
  memoryDraft: string;
  onCancel(): void;
  onMemoryDraftChange(value: string): void;
  onSave(): void;
  restoreFocus?(): HTMLElement | null;
  saving: boolean;
}) {
  const [discardConfirmationOpen, setDiscardConfirmationOpen] = useState(false);
  const requestCancel = () => {
    if (saving) {
      return;
    }
    if (memoryDraft !== folder.projectMemory) {
      setDiscardConfirmationOpen(true);
      return;
    }
    onCancel();
  };
  const dialogRef = useDialogFocus<HTMLDivElement>({
    autoFocus: !discardConfirmationOpen,
    closeOnEscape: !discardConfirmationOpen && !saving,
    containFocus: !discardConfirmationOpen,
    onClose: requestCancel,
    restoreFocus
  });

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-scrim/60 pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[max(.75rem,env(safe-area-inset-top))] sm:items-center sm:pb-[max(.75rem,env(safe-area-inset-bottom))] sm:pl-[max(.75rem,env(safe-area-inset-left))] sm:pr-[max(.75rem,env(safe-area-inset-right))]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          requestCancel();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="pop-enter flex max-h-[calc(100dvh-max(.75rem,env(safe-area-inset-top)))] w-full max-w-lg flex-col overflow-hidden rounded-t-panel border border-b-0 border-trace-subtle bg-overlay-surface text-ink shadow-overlay sm:max-h-[calc(100dvh-1.5rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] sm:rounded-panel sm:border [@media(max-height:32rem)]:max-h-[calc(100dvh-1rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))]"
        role="dialog"
        aria-modal="true"
        aria-hidden={discardConfirmationOpen || undefined}
        aria-label={`Project Settings ${folder.name}`}
        aria-busy={saving || undefined}
        inert={discardConfirmationOpen || undefined}
      >
        <header className="flex min-h-16 shrink-0 items-center justify-between gap-3 border-b border-trace-subtle px-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink">Project settings</h2>
            <p className="break-words text-xs text-ink-muted [overflow-wrap:anywhere]">{folder.name}</p>
          </div>
          <button
            className="grid size-11 shrink-0 place-items-center rounded-control text-ink-muted outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-proof/55 focus-visible:ring-offset-2 focus-visible:ring-offset-overlay-surface sm:size-9 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11"
            type="button"
            aria-label="Close project settings"
            disabled={saving}
            onClick={requestCancel}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5">
          <label className="mb-1 block text-xs font-medium text-ink-secondary" htmlFor="project-instructions">
            Project instructions
          </label>
          <textarea
            className="h-48 min-h-32 w-full resize-y rounded-control border border-trace-subtle bg-answer-paper p-3 text-sm leading-6 text-ink outline-none focus-visible:border-proof focus-visible:ring-2 focus-visible:ring-proof/55"
            id="project-instructions"
            aria-label="Project instructions"
            aria-describedby="project-instructions-help"
            disabled={saving}
            value={memoryDraft}
            onChange={(event) => onMemoryDraftChange(event.target.value)}
          />
          <p className="mt-2 text-xs leading-5 text-ink-muted" id="project-instructions-help">
            Sent to the model as context for future messages in every chat in this project. Existing messages and
            replies are unchanged.
          </p>
        </div>
        <footer className="flex shrink-0 justify-end gap-2 border-t border-trace-subtle px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:pb-3">
          <button
            className="h-touch rounded-control bg-control-surface px-3 text-sm font-medium text-ink-secondary outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-proof/55 focus-visible:ring-offset-2 focus-visible:ring-offset-overlay-surface sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
            type="button"
            disabled={saving}
            onClick={requestCancel}
          >
            Cancel
          </button>
          <button
            className="h-touch rounded-control bg-proof px-4 text-sm font-semibold text-proof-contrast outline-none hover:bg-proof-hover focus-visible:ring-2 focus-visible:ring-proof/55 focus-visible:ring-offset-2 focus-visible:ring-offset-overlay-surface disabled:opacity-50 sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
            type="button"
            disabled={saving}
            onClick={onSave}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
      {discardConfirmationOpen ? (
        <DiscardChangesConfirmationDialog
          label="project settings"
          onCancel={() => setDiscardConfirmationOpen(false)}
          onConfirm={() => {
            setDiscardConfirmationOpen(false);
            onCancel();
          }}
        />
      ) : null}
    </div>
  );
}
