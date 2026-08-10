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
          button: "bg-caution text-proof-contrast hover:opacity-90",
          icon: "border-caution/35 bg-caution/10 text-caution"
        }
      : {
          button: "bg-critical text-proof-contrast hover:opacity-90",
          icon: "border-critical/35 bg-critical/10 text-critical"
        };
  const ConfirmIcon = icon === "x" ? X : Trash2;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-scrim/70 pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[max(.75rem,env(safe-area-inset-top))] sm:items-center sm:pb-[max(.75rem,env(safe-area-inset-bottom))] sm:pl-[max(.75rem,env(safe-area-inset-left))] sm:pr-[max(.75rem,env(safe-area-inset-right))]"
      data-testid={testId}
      role="presentation"
      onMouseDown={onCancel}
    >
      <div
        ref={dialogRef}
        className="pop-enter max-h-[calc(100dvh-max(.75rem,env(safe-area-inset-top)))] w-full max-w-lg overflow-y-auto overscroll-contain rounded-t-panel border border-b-0 border-trace-subtle bg-overlay-surface px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 text-ink shadow-overlay sm:rounded-panel sm:border sm:p-5 [@media(max-height:32rem)]:max-h-[calc(100dvh-1rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))]"
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
            <h2 className="break-words text-base font-semibold text-ink [overflow-wrap:anywhere]">{title}</h2>
            <p className="mt-1 break-words text-sm leading-6 text-ink-secondary [overflow-wrap:anywhere]">{children}</p>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            className="flex h-touch items-center justify-center gap-1.5 rounded-control bg-control-surface px-3 text-sm font-medium text-ink-secondary outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-overlay-surface sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
            type="button"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            className={[
              "flex h-touch items-center justify-center gap-1.5 rounded-control px-3 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-overlay-surface disabled:opacity-50 sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch",
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

export function DiscardChangesConfirmationDialog({
  copy,
  label,
  onCancel,
  onConfirm
}: {
  copy?: Readonly<{
    body: string;
    cancelLabel: string;
    confirmLabel: string;
    dialogLabel: string;
    title: string;
  }>;
  label: string;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <ConfirmationDialog
      cancelLabel={copy?.cancelLabel ?? "Keep editing"}
      confirmLabel={copy?.confirmLabel ?? "Discard changes"}
      dialogLabel={copy?.dialogLabel ?? `Discard ${label} changes`}
      icon="x"
      onCancel={onCancel}
      onConfirm={onConfirm}
      testId="discard-changes-confirmation"
      title={copy?.title ?? "Discard changes?"}
      tone="warning"
    >
      {copy?.body ?? "Unsaved edits will be lost."}
    </ConfirmationDialog>
  );
}
