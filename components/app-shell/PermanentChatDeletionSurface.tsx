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
import type { MemoryUiLocale } from "@/lib/contracts/memory";
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

function t(locale: MemoryUiLocale, key: PermanentChatDeletionUiCopyKey): string {
  return permanentChatDeletionUiCopy(locale, key);
}

function formattedDate(locale: MemoryUiLocale, value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat(locale === "RU" ? "ru-RU" : "en-US", {
        dateStyle: "medium",
        timeStyle: "short"
      }).format(date);
}

function errorText(locale: MemoryUiLocale, code: string | null): string {
  switch (code) {
    case "chat_permanent_delete_stale":
    case "chat_permanent_delete_stale_review_required":
    case "active_run_in_progress":
      return t(locale, "stale");
    case "chat_permanent_delete_unavailable":
      return t(locale, "unavailable");
    default:
      return t(locale, "unknownError");
  }
}

function statusText(
  locale: MemoryUiLocale,
  state: ReturnType<typeof usePermanentChatDeletionStore.getState>["status"]
): string {
  switch (state?.state) {
    case "PENDING": return t(locale, "statePending");
    case "RUNNING": return t(locale, "stateRunning");
    case "RETRY_WAIT": return t(locale, "retryWait");
    case "BLOCKED_REQUIRES_ADMIN": return t(locale, "blocked");
    case "SUCCEEDED": return t(locale, "stateSucceeded");
    case "CANCELLED": return t(locale, "blocked");
    default: return t(locale, "statusBody");
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

function Confirmation({ locale }: Readonly<{ locale: MemoryUiLocale }>) {
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
            {t(locale, "confirmTitle")}
          </h2>
          <p className="mt-1 text-sm leading-6 text-ink-secondary">
            {t(locale, "confirmBody")}
          </p>
          <p className="mt-1 break-words text-sm font-semibold [overflow-wrap:anywhere]">
            “{target.title}”
          </p>
        </div>
        <button
          aria-label={t(locale, "cancel")}
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
          <span className="block font-semibold text-ink">{t(locale, "forgetLabel")}</span>
          <span className="mt-1 block leading-5 text-ink-muted">{t(locale, "forgetHelp")}</span>
        </span>
      </label>

      <details className="mt-3 border-y border-trace-subtle py-1">
        <summary className={`min-h-touch cursor-pointer py-3 text-sm font-semibold text-ink-secondary ${focusRing}`}>
          {t(locale, "advanced")}
        </summary>
        <div className="space-y-2 pb-3 text-xs leading-5 text-ink-muted">
          <p>{t(locale, "disclosureCrossChat")}</p>
          <p>{t(locale, "disclosureProvider")}</p>
          <p>{t(locale, "disclosureBackups")}</p>
        </div>
      </details>

      {error ? (
        <p className="mt-3 text-sm text-critical" role="alert">
          {errorText(locale, error)}
        </p>
      ) : null}

      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          className={`${button} bg-control-surface text-ink-secondary hover:bg-control-hover hover:text-ink`}
          disabled={busy}
          type="button"
          onClick={closePermanentChatDeletionDialog}
        >
          {t(locale, "cancel")}
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
          {t(locale, "confirmLabel")}
        </button>
      </div>
    </ModalFrame>
  );
}

function StatusDialog({ locale }: Readonly<{ locale: MemoryUiLocale }>) {
  const loadState = usePermanentChatDeletionStore((state) => state.statusLoadState);
  const error = usePermanentChatDeletionStore((state) => state.statusError);
  const reference = usePermanentChatDeletionStore((state) => state.reference);
  const status = usePermanentChatDeletionStore((state) => state.status);
  const open = usePermanentChatDeletionStore((state) => state.statusOpen);
  if (!open || !reference) return null;
  const completed = status?.state === "SUCCEEDED";
  const blocked = status?.state === "BLOCKED_REQUIRES_ADMIN" ||
    status?.state === "CANCELLED";
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
            {t(locale, "statusTitle")}
          </h2>
          <p className={`mt-1 text-sm leading-6 ${blocked ? "text-critical" : "text-ink-secondary"}`}>
            {statusText(locale, status)}
          </p>
          {!completed && !blocked ? (
            <p className="mt-1 text-xs leading-5 text-ink-muted">{t(locale, "statusBody")}</p>
          ) : null}
        </div>
        <button
          aria-label={t(locale, "close")}
          className={`grid size-10 shrink-0 place-items-center rounded-control text-ink-muted hover:bg-control-hover hover:text-ink ${focusRing}`}
          type="button"
          onClick={closePermanentChatDeletionDialog}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      {error ? (
        <p className="mt-3 text-sm text-critical" role="alert">
          {errorText(locale, error)}
        </p>
      ) : null}

      <details className="mt-4 border-y border-trace-subtle py-1">
        <summary className={`min-h-touch cursor-pointer py-3 text-sm font-semibold text-ink-secondary ${focusRing}`}>
          {t(locale, "advanced")}
        </summary>
        <dl className="divide-y divide-trace-subtle pb-2 text-xs">
          {[
            [t(locale, "advancedReference"), reference.deletionId],
            [t(locale, "advancedAttempts"), String(status?.attemptCount ?? 0)],
            [t(locale, "advancedFenced"), formattedDate(locale, status?.fencedAt ?? null)],
            [t(locale, "advancedUpdated"), formattedDate(locale, status?.updatedAt ?? null)],
            [t(locale, "advancedLastAudit"), formattedDate(locale, status?.lastAuditAt ?? null)],
            [t(locale, "advancedError"), status?.errorCode ?? "—"]
          ].map(([label, value]) => (
            <div className="grid gap-1 py-2 sm:grid-cols-[9rem_minmax(0,1fr)]" key={label}>
              <dt className="font-medium text-ink-muted">{label}</dt>
              <dd className="break-all font-mono text-ink-secondary">{value}</dd>
            </div>
          ))}
        </dl>
      </details>

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {!completed ? (
          <button
            className={`${button} bg-control-surface text-ink-secondary hover:bg-control-hover hover:text-ink`}
            disabled={loadState === "loading"}
            type="button"
            onClick={() => void refreshPermanentChatDeletionStatus().catch(() => undefined)}
          >
            <RotateCw className={`size-4 ${loadState === "loading" ? "animate-spin" : ""}`} aria-hidden="true" />
            {loadState === "loading" ? t(locale, "refreshing") : t(locale, "refresh")}
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
          {t(locale, "close")}
        </button>
      </div>
    </ModalFrame>
  );
}

function ProgressNotice({ locale }: Readonly<{ locale: MemoryUiLocale }>) {
  const reference = usePermanentChatDeletionStore((state) => state.reference);
  const status = usePermanentChatDeletionStore((state) => state.status);
  const statusOpen = usePermanentChatDeletionStore((state) => state.statusOpen);
  const target = usePermanentChatDeletionStore((state) => state.target);
  if (!reference || statusOpen || target) return null;
  const blocked = status?.state === "BLOCKED_REQUIRES_ADMIN" ||
    status?.state === "CANCELLED";
  const completed = status?.state === "SUCCEEDED";
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
          {t(locale, blocked ? "noticeBlocked" : completed ? "noticeSucceeded" : "noticePending")}
        </p>
        <button
          className={`${button} shrink-0 bg-control-surface text-ink-secondary hover:bg-control-hover hover:text-ink`}
          type="button"
          onClick={openPermanentChatDeletionStatus}
        >
          {t(locale, "noticeAction")}
        </button>
      </div>
    </div>
  );
}

export function PermanentChatDeletionSurface({ locale }: Readonly<{
  locale: MemoryUiLocale;
}>) {
  const reference = usePermanentChatDeletionStore((state) => state.reference);
  const state = usePermanentChatDeletionStore((current) => current.status?.state ?? null);

  useEffect(() => {
    if (!reference || !state || ["CANCELLED", "SUCCEEDED"].includes(state)) return;
    const timer = window.setTimeout(() => {
      void refreshPermanentChatDeletionStatus(reference).catch(() => undefined);
    }, state === "BLOCKED_REQUIRES_ADMIN" ? 10_000 : 3_000);
    return () => window.clearTimeout(timer);
  }, [reference, state]);

  return (
    <>
      <Confirmation locale={locale} />
      <StatusDialog locale={locale} />
      <ProgressNotice locale={locale} />
    </>
  );
}
