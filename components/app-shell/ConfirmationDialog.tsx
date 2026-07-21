import { AlertTriangle, Trash2, X } from "lucide-react";
import { useDialogFocus } from "./useDialogFocus";

type ConfirmationTone = "destructive" | "warning";

type ConfirmationDialogProps = {
  cancelLabel?: string;
  children: string;
  confirmLabel: string;
  dialogLabel: string;
  icon?: "trash" | "x";
  onCancel(): void;
  onConfirm(): void;
  testId: string;
  title: string;
  tone?: ConfirmationTone;
};

export function ConfirmationDialog({
  cancelLabel = "Cancel",
  children,
  confirmLabel,
  dialogLabel,
  icon = "trash",
  onCancel,
  onConfirm,
  testId,
  title,
  tone = "destructive"
}: ConfirmationDialogProps) {
  const dialogRef = useDialogFocus<HTMLDivElement>({ onClose: onCancel });
  const toneClasses =
    tone === "warning"
      ? {
          button: "border-accent-amber/40 bg-accent-amber/10 text-accent-amber hover:bg-accent-amber/15",
          icon: "border-accent-amber/30 bg-accent-amber/10 text-accent-amber"
        }
      : {
          button: "border-accent-rose/40 bg-accent-rose/10 text-accent-rose hover:bg-accent-rose/15",
          icon: "border-accent-rose/30 bg-accent-rose/10 text-accent-rose"
        };
  const ConfirmIcon = icon === "x" ? X : Trash2;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-scrim/70 pb-[max(.75rem,env(safe-area-inset-bottom))] pl-[max(.75rem,env(safe-area-inset-left))] pr-[max(.75rem,env(safe-area-inset-right))] pt-[max(.75rem,env(safe-area-inset-top))] backdrop-blur-sm"
      data-testid={testId}
      role="presentation"
      onMouseDown={onCancel}
    >
      <div
        ref={dialogRef}
        className="pop-enter max-h-[calc(100dvh-1.5rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] w-full max-w-lg overflow-y-auto overscroll-contain rounded-panel border border-separator-subtle bg-surface-overlay p-4 shadow-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={dialogLabel}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className={["grid size-8 shrink-0 place-items-center rounded-control border", toneClasses.icon].join(" ")}>
            <AlertTriangle className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="break-words text-sm font-semibold text-content-primary [overflow-wrap:anywhere]">{title}</h2>
            <p className="mt-1 break-words text-xs leading-5 text-content-secondary [overflow-wrap:anywhere]">{children}</p>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            className="flex h-touch items-center justify-center gap-1.5 rounded-control bg-surface-raised px-3 text-xs font-medium text-content-secondary outline-none hover:bg-surface-hover hover:text-content-primary focus-visible:ring-2 focus-visible:ring-accent-cyan/55 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-overlay sm:h-control-sm [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
            type="button"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            className={[
              "flex h-touch items-center justify-center gap-1.5 rounded-control border px-3 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/55 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-overlay disabled:opacity-50 sm:h-control-sm [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch",
              toneClasses.button
            ].join(" ")}
            type="button"
            aria-label={`Confirm ${confirmLabel.toLowerCase()}`}
            onClick={onConfirm}
          >
            <ConfirmIcon className="size-3.5" aria-hidden="true" />
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ChatDeleteConfirmationDialog({
  chatTitle,
  onCancel,
  onConfirm
}: {
  chatTitle: string;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <ConfirmationDialog
      confirmLabel="Delete chat"
      dialogLabel={`Delete chat ${chatTitle}`}
      onCancel={onCancel}
      onConfirm={onConfirm}
      testId="delete-chat-confirmation"
      title="Delete chat?"
    >
      {`"${chatTitle}" will be archived and removed from the workspace list.`}
    </ConfirmationDialog>
  );
}

export function FolderDeleteConfirmationDialog({
  folderName,
  onCancel,
  onConfirm
}: {
  folderName: string;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <ConfirmationDialog
      confirmLabel="Delete folder"
      dialogLabel={`Delete folder ${folderName}`}
      onCancel={onCancel}
      onConfirm={onConfirm}
      testId="delete-folder-confirmation"
      title="Delete folder?"
    >
      {`"${folderName}" will be removed. Chats inside move to the top level, and subfolders move up one level.`}
    </ConfirmationDialog>
  );
}

export function MessageDeleteConfirmationDialog({
  onCancel,
  onConfirm
}: {
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <ConfirmationDialog
      confirmLabel="Delete message"
      dialogLabel="Delete message"
      onCancel={onCancel}
      onConfirm={onConfirm}
      testId="delete-message-confirmation"
      title="Delete message?"
    >
      This message and every reply below it will be removed from the branch.
    </ConfirmationDialog>
  );
}

export function PromptDeleteConfirmationDialog({
  onCancel,
  onConfirm,
  promptName
}: {
  onCancel(): void;
  onConfirm(): void;
  promptName: string;
}) {
  return (
    <ConfirmationDialog
      confirmLabel="Delete prompt"
      dialogLabel={`Delete prompt ${promptName}`}
      onCancel={onCancel}
      onConfirm={onConfirm}
      testId="delete-prompt-confirmation"
      title="Delete prompt?"
    >
      {`"${promptName}" will be removed from your prompt presets.`}
    </ConfirmationDialog>
  );
}

export function DiscardChangesConfirmationDialog({
  label,
  onCancel,
  onConfirm
}: {
  label: string;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <ConfirmationDialog
      cancelLabel="Keep editing"
      confirmLabel="Discard changes"
      dialogLabel={`Discard ${label} changes`}
      icon="x"
      onCancel={onCancel}
      onConfirm={onConfirm}
      testId="discard-changes-confirmation"
      title="Discard changes?"
      tone="warning"
    >
      Unsaved edits will be lost.
    </ConfirmationDialog>
  );
}
