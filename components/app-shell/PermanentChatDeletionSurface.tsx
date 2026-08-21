import {
  closePermanentChatDeletionDialog,
  confirmPermanentChatDeletion,
  dismissCompletedPermanentChatDeletion,
  openPermanentChatDeletionStatus,
  refreshPermanentChatDeletionStatus,
  setPermanentChatDeletionOriginForget,
  usePermanentChatDeletionStore
} from "@/components/app-shell/permanentChatDeletionStore";
import {
  permanentChatDeletionUiCopy,
  type PermanentChatDeletionUiCopyKey
} from "@/components/app-shell/permanentChatDeletionUiCopy";
import { useDialogFocus } from "@/components/app-shell/useDialogFocus";
import {
  AlertTriangle,
  Check,
  CircleAlert,
  LoaderCircle,
  RotateCw,
  ShieldAlert,
  Trash2,
  X
} from "lucide-react";
import { useEffect } from "react";

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-overlay-surface";
const button =
  `inline-flex min-h-touch items-center justify-center gap-2 rounded-control px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-control ${focusRing}`;

function t(key: PermanentChatDeletionUiCopyKey): string {
  return permanentChatDeletionUiCopy(key);
}

function errorText(reason: string | null): string {
  switch (reason) {
    case "BUSY": return t("busy");
    case "CHANGED": return t("stale");
    case "UNAVAILABLE":
      return t("unavailable");
    default:
      return t("unknownError");
  }
}

function statusText(
  state: ReturnType<typeof usePermanentChatDeletionStore.getState>["status"]
): string {
  switch (state?.status) {
    case "IN_PROGRESS": return t("stateRunning");
    case "NEEDS_ATTENTION": return t("blocked");
    case "COMPLETE": return t("stateSucceeded");
    default: return t("statusBody");
  }
}

function ModalFrame({
  children,
  labelledBy
}: Readonly<{ children: React.ReactNode; labelledBy: string }>) {
  const dialogRef = useDialogFocus<HTMLDivElement>({
    onClose: closePermanentChatDeletionDialog
  });
  return (
    <div
      className="fixed inset-0 z-[110] flex items-end justify-center bg-scrim/70 pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[max(.75rem,env(safe-area-inset-top))] sm:items-center sm:pb-[max(.75rem,env(safe-area-inset-bottom))] sm:pl-[max(.75rem,env(safe-area-inset-left))] sm:pr-[max(.75rem,env(safe-area-inset-right))]"
      data-testid="permanent-chat-deletion-dialog"
      role="presentation"
      onMouseDown={closePermanentChatDeletionDialog}
    >
      <div
        ref={dialogRef}
        aria-labelledby={labelledBy}
        aria-modal="true"
        className="pop-enter max-h-[calc(100dvh-max(.75rem,env(safe-area-inset-top)))] w-full max-w-lg overflow-y-auto overscroll-contain rounded-t-panel border border-b-0 border-trace-subtle bg-overlay-surface px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 text-ink shadow-overlay sm:rounded-panel sm:border sm:p-5 [@media(max-height:32rem)]:max-h-[calc(100dvh-1rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))]"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function Confirmation() {
  const alsoForget = usePermanentChatDeletionStore(
    (state) => state.alsoForgetOriginMemories
  );
  const busy = usePermanentChatDeletionStore((state) => state.busy);
  const error = usePermanentChatDeletionStore((state) => state.confirmationError);
  const target = usePermanentChatDeletionStore((state) => state.target);
  if (!target) return null;
  return (
    <ModalFrame labelledBy="permanent-chat-deletion-heading">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-control border border-critical/35 bg-critical/10 text-critical">
          <AlertTriangle className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2
            className="break-words text-base font-semibold [overflow-wrap:anywhere]"
            id="permanent-chat-deletion-heading"
          >
            {t("confirmTitle")}
          </h2>
          <p className="mt-1 text-sm leading-6 text-ink-secondary">
            {t("confirmBody")}
          </p>
          <p className="mt-1 break-words text-sm font-semibold [overflow-wrap:anywhere]">
            “{target.title}”
          </p>
        </div>
        <button
          aria-label={t("cancel")}
          className={`grid size-10 shrink-0 place-items-center rounded-control text-ink-muted hover:bg-control-hover hover:text-ink ${focusRing}`}
          disabled={busy}
          type="button"
          onClick={closePermanentChatDeletionDialog}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-control border border-trace-subtle bg-control-surface px-3 py-3 text-sm">
        <input
          checked={alsoForget}
          className="mt-1 size-4 shrink-0 accent-proof"
          disabled={busy}
          type="checkbox"
          onChange={(event) =>
            setPermanentChatDeletionOriginForget(event.currentTarget.checked)}
        />
        <span>
          <span className="block font-semibold text-ink">{t("forgetLabel")}</span>
          <span className="mt-1 block leading-5 text-ink-muted">{t("forgetHelp")}</span>
        </span>
      </label>

      <details className="mt-3 border-y border-trace-subtle py-1">
        <summary className={`min-h-touch cursor-pointer py-3 text-sm font-semibold text-ink-secondary ${focusRing}`}>
          {t("advanced")}
        </summary>
        <div className="space-y-2 pb-3 text-xs leading-5 text-ink-muted">
          <p>{t("disclosureCrossChat")}</p>
          <p>{t("disclosureProvider")}</p>
          <p>{t("disclosureBackups")}</p>
        </div>
      </details>

      {error ? (
        <p className="mt-3 text-sm text-critical" role="alert">
          {errorText(error)}
        </p>
      ) : null}

      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          className={`${button} bg-control-surface text-ink-secondary hover:bg-control-hover hover:text-ink`}
          disabled={busy}
          type="button"
          onClick={closePermanentChatDeletionDialog}
        >
          {t("cancel")}
        </button>
        <button
          className={`${button} bg-critical px-4 text-proof-contrast hover:opacity-90`}
          disabled={busy}
          type="button"
          onClick={() => void confirmPermanentChatDeletion().catch(() => undefined)}
        >
          {busy
            ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            : <Trash2 className="size-4" aria-hidden="true" />}
          {t("confirmLabel")}
        </button>
      </div>
    </ModalFrame>
  );
}

function StatusDialog() {
  const loadState = usePermanentChatDeletionStore((state) => state.statusLoadState);
  const error = usePermanentChatDeletionStore((state) => state.statusError);
  const reference = usePermanentChatDeletionStore((state) => state.reference);
  const status = usePermanentChatDeletionStore((state) => state.status);
  const open = usePermanentChatDeletionStore((state) => state.statusOpen);
  if (!open || !reference) return null;
  const completed = status?.status === "COMPLETE";
  const blocked = status?.status === "NEEDS_ATTENTION";
  return (
    <ModalFrame labelledBy="permanent-chat-deletion-status-heading">
      <div className="flex items-start gap-3">
        <span className={`grid size-9 shrink-0 place-items-center rounded-control border ${
          blocked
            ? "border-critical/35 bg-critical/10 text-critical"
            : completed
              ? "border-positive/35 bg-positive/10 text-positive"
              : "border-proof/30 bg-proof/10 text-proof"
        }`}>
          {blocked
            ? <ShieldAlert className="size-4" aria-hidden="true" />
            : completed
              ? <Check className="size-4" aria-hidden="true" />
              : <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />}
        </span>
        <div className="min-w-0 flex-1" aria-live="polite">
          <h2 className="text-base font-semibold" id="permanent-chat-deletion-status-heading">
            {t("statusTitle")}
          </h2>
          <p className={`mt-1 text-sm leading-6 ${blocked ? "text-critical" : "text-ink-secondary"}`}>
            {statusText(status)}
          </p>
          {!completed && !blocked ? (
            <p className="mt-1 text-xs leading-5 text-ink-muted">{t("statusBody")}</p>
          ) : null}
        </div>
        <button
          aria-label={t("close")}
          className={`grid size-10 shrink-0 place-items-center rounded-control text-ink-muted hover:bg-control-hover hover:text-ink ${focusRing}`}
          type="button"
          onClick={closePermanentChatDeletionDialog}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      {error ? (
        <p className="mt-3 text-sm text-critical" role="alert">
          {errorText(error)}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {!completed ? (
          <button
            className={`${button} bg-control-surface text-ink-secondary hover:bg-control-hover hover:text-ink`}
            disabled={loadState === "loading"}
            type="button"
            onClick={() => void refreshPermanentChatDeletionStatus().catch(() => undefined)}
          >
            <RotateCw className={`size-4 ${loadState === "loading" ? "animate-spin" : ""}`} aria-hidden="true" />
            {loadState === "loading" ? t("refreshing") : t("refresh")}
          </button>
        ) : null}
        <button
          className={`${button} ${completed ? "bg-proof text-proof-contrast hover:bg-proof-hover" : "bg-control-surface text-ink-secondary hover:bg-control-hover hover:text-ink"}`}
          type="button"
          onClick={() => {
            if (completed) dismissCompletedPermanentChatDeletion();
            else closePermanentChatDeletionDialog();
          }}
        >
          {t("close")}
        </button>
      </div>
    </ModalFrame>
  );
}

function ProgressNotice() {
  const reference = usePermanentChatDeletionStore((state) => state.reference);
  const status = usePermanentChatDeletionStore((state) => state.status);
  const statusOpen = usePermanentChatDeletionStore((state) => state.statusOpen);
  const target = usePermanentChatDeletionStore((state) => state.target);
  if (!reference || statusOpen || target) return null;
  const blocked = status?.status === "NEEDS_ATTENTION";
  const completed = status?.status === "COMPLETE";
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[max(.75rem,env(safe-area-inset-bottom))] z-[85] flex justify-center px-3">
      <div
        className={`pointer-events-auto flex w-full max-w-lg items-center gap-3 rounded-panel border bg-overlay-surface px-3 py-2 shadow-overlay ${
          blocked ? "border-critical/40" : "border-trace-subtle"
        }`}
        role={blocked ? "alert" : "status"}
      >
        {blocked
          ? <CircleAlert className="size-4 shrink-0 text-critical" aria-hidden="true" />
          : completed
            ? <Check className="size-4 shrink-0 text-positive" aria-hidden="true" />
            : <LoaderCircle className="size-4 shrink-0 animate-spin text-proof" aria-hidden="true" />}
        <p className="min-w-0 flex-1 text-sm font-medium text-ink-secondary">
          {t(blocked ? "noticeBlocked" : completed ? "noticeSucceeded" : "noticePending")}
        </p>
        <button
          className={`${button} shrink-0 bg-control-surface text-ink-secondary hover:bg-control-hover hover:text-ink`}
          type="button"
          onClick={openPermanentChatDeletionStatus}
        >
          {t("noticeAction")}
        </button>
      </div>
    </div>
  );
}

export function PermanentChatDeletionSurface() {
  const reference = usePermanentChatDeletionStore((state) => state.reference);
  const status = usePermanentChatDeletionStore((current) => current.status?.status ?? null);

  useEffect(() => {
    if (!reference || !status || status === "COMPLETE") return;
    const timer = window.setTimeout(() => {
      void refreshPermanentChatDeletionStatus(reference).catch(() => undefined);
    }, status === "NEEDS_ATTENTION" ? 10_000 : 3_000);
    return () => window.clearTimeout(timer);
  }, [reference, status]);

  return (
    <>
      <Confirmation />
      <StatusDialog />
      <ProgressNotice />
    </>
  );
}
