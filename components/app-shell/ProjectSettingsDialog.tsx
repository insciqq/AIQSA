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
      className="fixed inset-0 z-40 grid place-items-center bg-scrim/55 pb-[max(.75rem,env(safe-area-inset-bottom))] pl-[max(.75rem,env(safe-area-inset-left))] pr-[max(.75rem,env(safe-area-inset-right))] pt-[max(.75rem,env(safe-area-inset-top))]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          requestCancel();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="pop-enter max-h-[calc(100dvh-1.5rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] w-full max-w-lg overflow-y-auto overscroll-contain rounded-panel border border-separator-subtle bg-surface-overlay p-4 shadow-overlay"
        role="dialog"
        aria-modal="true"
        aria-hidden={discardConfirmationOpen || undefined}
        aria-label={`Project Settings ${folder.name}`}
        aria-busy={saving || undefined}
        inert={discardConfirmationOpen || undefined}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-content-primary">Project Settings</h2>
            <p className="break-words text-xs text-content-muted [overflow-wrap:anywhere]">{folder.name}</p>
          </div>
          <button
            className="grid size-11 shrink-0 place-items-center rounded-control bg-surface-raised text-content-secondary outline-none hover:bg-surface-hover hover:text-content-primary focus-visible:ring-2 focus-visible:ring-accent-cyan/55 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-overlay sm:size-8 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11"
            type="button"
            aria-label="Close project settings"
            disabled={saving}
            onClick={requestCancel}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        <label className="mb-1 block text-xs font-medium text-content-secondary" htmlFor="project-instructions">
          Project instructions
        </label>
        <textarea
          className="h-40 min-h-28 w-full resize-none rounded-control border border-separator-subtle bg-surface-thread p-3 text-sm leading-6 text-content-primary outline-none focus-visible:border-accent-cyan focus-visible:ring-2 focus-visible:ring-accent-cyan/55"
          id="project-instructions"
          aria-label="Project instructions"
          aria-describedby="project-instructions-help"
          disabled={saving}
          value={memoryDraft}
          onChange={(event) => onMemoryDraftChange(event.target.value)}
        />
        <p className="mt-2 text-xs leading-5 text-content-muted" id="project-instructions-help">
          Sent to the model as context for future messages in every chat in this project. Existing messages and
          replies are unchanged.
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <button
            className="h-touch rounded-control bg-surface-raised px-3 text-xs font-medium text-content-secondary outline-none hover:bg-surface-hover hover:text-content-primary focus-visible:ring-2 focus-visible:ring-accent-cyan/55 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-overlay sm:h-control-sm [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
            type="button"
            disabled={saving}
            onClick={requestCancel}
          >
            Cancel
          </button>
          <button
            className="h-touch rounded-control bg-accent-cyan px-3 text-xs font-semibold text-surface-canvas outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/55 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-overlay disabled:opacity-50 sm:h-control-sm [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
            type="button"
            disabled={saving}
            onClick={onSave}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
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
