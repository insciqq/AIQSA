import {
  cancelActiveMemoryRebuild,
  confirmSelectedMemoryOperation,
  dismissMemoryOperationStatus,
  refreshMemoryAllStatus,
  refreshMemoryClearStatus,
  refreshMemoryLearnedStatus,
  refreshMemoryRebuildStatus,
  selectMemoryOperation,
  useMemoryOperationsStore,
  type MemoryOperationsAction
} from "@/components/app-shell/memoryOperationsStore";
import {
  memoryOperationsUiCopy,
  type MemoryOperationsUiCopyKey
} from "@/components/app-shell/memoryOperationsUiCopy";
import type {
  MemoryDeletionStatus,
  MemoryRebuildStatus,
  MemorySettingsResponse,
  MemoryUiLocale
} from "@/lib/contracts/memory";
import {
  ArrowLeft,
  Check,
  CircleAlert,
  DatabaseZap,
  Eraser,
  Fingerprint,
  LoaderCircle,
  RefreshCw,
  RotateCw,
  ShieldAlert,
  Sparkles,
  X
} from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-overlay-surface";
const coarsePointerTarget =
  "[@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch";
const secondaryButton =
  `inline-flex min-h-touch items-center justify-center gap-2 rounded-control border border-trace-subtle bg-control-surface px-3 text-sm font-semibold text-ink-secondary hover:bg-control-hover hover:text-ink disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-60 sm:min-h-control ${coarsePointerTarget} ${focusRing}`;
const quietButton =
  `inline-flex min-h-touch items-center justify-center gap-2 rounded-control px-3 text-sm font-semibold text-ink-secondary hover:bg-control-hover hover:text-ink disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-60 sm:min-h-control ${coarsePointerTarget} ${focusRing}`;
const primaryButton =
  `inline-flex min-h-touch items-center justify-center gap-2 rounded-control bg-proof px-4 text-sm font-semibold text-proof-contrast hover:bg-proof-hover disabled:cursor-not-allowed disabled:bg-control-surface disabled:text-ink-disabled sm:min-h-control ${coarsePointerTarget} ${focusRing}`;
const destructiveButton =
  `inline-flex min-h-touch items-center justify-center gap-2 rounded-control border border-critical/50 bg-critical/10 px-4 text-sm font-semibold text-critical hover:bg-critical/15 disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-control ${coarsePointerTarget} ${focusRing}`;

function t(locale: MemoryUiLocale, key: MemoryOperationsUiCopyKey): string {
  return memoryOperationsUiCopy(locale, key);
}

function formatDate(locale: MemoryUiLocale, value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function operationLabel(locale: MemoryUiLocale, operation: MemoryOperationsAction): string {
  switch (operation) {
    case "REBUILD_SEARCH_INDEX": return t(locale, "rebuildLabel");
    case "REEMBED": return t(locale, "reembedLabel");
    case "REDREAM_EXISTING_CHATS": return t(locale, "redreamLabel");
    case "DELETE_ALL_REUSABLE": return t(locale, "allLabel");
    case "DELETE_LEARNED": return t(locale, "learnedLabel");
    case "CLEAR_HISTORY_INDEX": return t(locale, "clearLabel");
  }
}

function confirmationText(locale: MemoryUiLocale, operation: MemoryOperationsAction): string {
  switch (operation) {
    case "REBUILD_SEARCH_INDEX": return t(locale, "confirmationRebuild");
    case "REEMBED": return t(locale, "confirmationReembed");
    case "REDREAM_EXISTING_CHATS": return t(locale, "confirmationRedream");
    case "DELETE_ALL_REUSABLE": return t(locale, "confirmationAll");
    case "DELETE_LEARNED": return t(locale, "confirmationLearned");
    case "CLEAR_HISTORY_INDEX": return t(locale, "confirmationClear");
  }
}

function errorText(locale: MemoryUiLocale, code: string | null): string {
  switch (code) {
    case "memory_version_stale": return t(locale, "errorStale");
    case "memory_egress_consent_required": return t(locale, "errorConsent");
    case "memory_embedding_unavailable": return t(locale, "errorEmbedding");
    case "memory_rebuild_in_progress": return t(locale, "errorInProgress");
    case "memory_intent_confirmation_required": return t(locale, "errorConfirmation");
    case "memory_deletion_reference_mismatch": return t(locale, "errorReferenceMismatch");
    case "memory_rebuild_not_found": return t(locale, "errorNotFound");
    default: return t(locale, "errorGeneric");
  }
}

function rebuildStateText(locale: MemoryUiLocale, status: MemoryRebuildStatus): string {
  switch (status.state) {
    case "QUEUED": return t(locale, "stateQueued");
    case "RUNNING": return t(locale, "stateRebuildRunning");
    case "WAITING_FOR_EGRESS_CONSENT": return t(locale, "stateWaitingConsent");
    case "CATCHING_UP": return t(locale, "stateCatchingUp");
    case "READY": return t(locale, "stateReady");
    case "SUCCEEDED": return t(locale, "stateRebuildSucceeded");
    case "FAILED": return t(locale, "stateFailed");
    case "STALE": return t(locale, "stateStale");
    case "CANCELLED": return t(locale, "stateCancelled");
  }
}

type DeletionKind = "all" | "clear" | "learned";

function deletionStateText(
  kind: DeletionKind,
  locale: MemoryUiLocale,
  status: MemoryDeletionStatus
): string {
  switch (status.state) {
    case "PENDING": return t(locale, kind === "all" ? "stateAllPending" : "statePending");
    case "RUNNING": return t(locale, kind === "all"
      ? "stateAllRunning"
      : kind === "learned" ? "stateLearnedRunning" : "stateClearRunning");
    case "RETRY_WAIT": return t(locale, kind === "all"
      ? "stateAllRetry"
      : kind === "learned" ? "stateLearnedRetry" : "stateRetry");
    case "BLOCKED_REQUIRES_ADMIN": return t(locale, kind === "all"
      ? "stateAllBlocked"
      : kind === "learned" ? "stateLearnedBlocked" : "stateBlocked");
    case "SUCCEEDED": return t(locale, kind === "all"
      ? "stateAllSucceeded"
      : kind === "learned" ? "stateLearnedSucceeded" : "stateClearSucceeded");
    case "CANCELLED": return "Deletion cancelled.";
  }
}

function Progress({
  completed,
  label,
  total
}: {
  completed: number;
  label: string;
  total: number | null;
}) {
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between gap-3 text-xs text-ink-muted">
        <span>{label}</span>
        <span>{completed}{total === null ? "" : ` / ${total}`}</span>
      </div>
      {total !== null && total > 0 ? (
        <progress
          aria-label={label}
          className="mt-2 h-1.5 w-full overflow-hidden rounded-full accent-proof"
          max={total}
          value={completed}
        />
      ) : null}
    </div>
  );
}

function StatusMetadata({
  locale,
  reference,
  updatedAt,
  auditAt
}: {
  auditAt?: string | null;
  locale: MemoryUiLocale;
  reference: string;
  updatedAt: string;
}) {
  return (
    <dl className="mt-3 divide-y divide-trace-subtle text-xs">
      <div className="grid gap-1 py-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
        <dt className="font-medium text-ink-muted">{t(locale, "reference")}</dt>
        <dd><code className="break-all font-mono text-ink-secondary">{reference}</code></dd>
      </div>
      <div className="grid gap-1 py-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
        <dt className="font-medium text-ink-muted">{t(locale, "updated")}</dt>
        <dd className="text-ink-secondary">{formatDate(locale, updatedAt)}</dd>
      </div>
      {auditAt !== undefined ? (
        <div className="grid gap-1 py-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <dt className="font-medium text-ink-muted">{t(locale, "lastAudit")}</dt>
          <dd className="text-ink-secondary">{formatDate(locale, auditAt)}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function RebuildStatus({ locale }: { locale: MemoryUiLocale }) {
  const busy = useMemoryOperationsStore((state) => state.busy);
  const error = useMemoryOperationsStore((state) => state.rebuildError);
  const loadState = useMemoryOperationsStore((state) => state.rebuildLoadState);
  const status = useMemoryOperationsStore((state) => state.rebuildStatus);
  if (!status) return null;
  const terminal = ["CANCELLED", "FAILED", "STALE", "SUCCEEDED"].includes(status.state);
  const failed = status.state === "FAILED";
  return (
    <section className="border-y border-trace-subtle py-4" aria-labelledby="memory-rebuild-status-heading">
      <div className="flex items-start gap-3">
        <RefreshCw className="mt-0.5 size-4 shrink-0 text-proof" aria-hidden="true" />
        <div className="min-w-0 flex-1" aria-live="polite" aria-busy={loadState === "loading"}>
          <h4 className="text-sm font-semibold text-ink" id="memory-rebuild-status-heading">
            {t(locale, "rebuildStatusHeading")}
          </h4>
          <p className="mt-1 text-xs font-semibold text-ink-secondary">
            {operationLabel(locale, status.operation)}
          </p>
          <p className={`mt-2 text-sm leading-6 ${failed ? "text-critical" : "text-ink-secondary"}`}>
            {rebuildStateText(locale, status)}
          </p>
          {failed && status.errorCode ? (
            <p className="mt-2 text-sm text-critical" role="alert">{errorText(locale, status.errorCode)}</p>
          ) : null}
          <Progress completed={status.completedUnits} label={t(locale, "progress")} total={status.totalUnits} />
          <StatusMetadata locale={locale} reference={status.jobId} updatedAt={status.updatedAt} />
          {error ? <p className="mt-3 text-sm text-critical" role="alert">{errorText(locale, error)}</p> : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {!terminal ? (
              <>
                <button
                  className={secondaryButton}
                  disabled={loadState === "loading" || busy !== null}
                  type="button"
                  onClick={() => void refreshMemoryRebuildStatus().catch(() => undefined)}
                >
                  <RotateCw className="size-4" aria-hidden="true" />
                  {t(locale, "refresh")}
                </button>
                <button
                  className={secondaryButton}
                  disabled={busy !== null}
                  type="button"
                  onClick={() => void cancelActiveMemoryRebuild().catch(() => undefined)}
                >
                  {busy === "cancelling"
                    ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    : <X className="size-4" aria-hidden="true" />}
                  {busy === "cancelling" ? t(locale, "cancelling") : t(locale, "cancelJob")}
                </button>
              </>
            ) : (
              <button className={secondaryButton} type="button" onClick={() => dismissMemoryOperationStatus("rebuild")}>
                {t(locale, "dismiss")}
              </button>
            )}
          </div>
          <p className="mt-3 text-xs leading-5 text-ink-muted">{t(locale, "cancelBoundary")}</p>
        </div>
      </div>
    </section>
  );
}

function DeletionStatus({ kind, locale }: {
  kind: DeletionKind;
  locale: MemoryUiLocale;
}) {
  const error = useMemoryOperationsStore((state) =>
    kind === "all"
      ? state.allError
      : kind === "learned" ? state.learnedError : state.clearError
  );
  const loadState = useMemoryOperationsStore((state) =>
    kind === "all"
      ? state.allLoadState
      : kind === "learned" ? state.learnedLoadState : state.clearLoadState
  );
  const status = useMemoryOperationsStore((state) =>
    kind === "all"
      ? state.allStatus
      : kind === "learned" ? state.learnedStatus : state.clearStatus
  );
  if (!status) return null;
  const blocked = status.state === "BLOCKED_REQUIRES_ADMIN";
  const succeeded = status.state === "SUCCEEDED";
  const terminal = succeeded || status.state === "CANCELLED";
  const headingId = `memory-${kind}-status-heading`;
  return (
    <section className="border-y border-trace-subtle py-4" aria-labelledby={headingId}>
      <div className="flex items-start gap-3">
        <Eraser className={`mt-0.5 size-4 shrink-0 ${blocked ? "text-critical" : succeeded ? "text-positive" : "text-caution"}`} aria-hidden="true" />
        <div className="min-w-0 flex-1" aria-live="polite" aria-busy={loadState === "loading"}>
          <h4 className="text-sm font-semibold text-ink" id={headingId}>
            {t(locale, kind === "all"
              ? "allStatusHeading"
              : kind === "learned" ? "learnedStatusHeading" : "clearStatusHeading")}
          </h4>
          <p className={`mt-2 text-sm leading-6 ${blocked ? "text-critical" : "text-ink-secondary"}`}>
            {deletionStateText(kind, locale, status)}
          </p>
          <Progress completed={status.completedUnits} label={t(locale, "progress")} total={status.totalUnits} />
          <StatusMetadata
            auditAt={status.lastAuditAt}
            locale={locale}
            reference={status.deletionId}
            updatedAt={status.updatedAt}
          />
          {error ? <p className="mt-3 text-sm text-critical" role="alert">{errorText(locale, error)}</p> : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {!terminal ? (
              <button
                className={secondaryButton}
                disabled={loadState === "loading"}
                type="button"
                onClick={() => void (kind === "all"
                  ? refreshMemoryAllStatus()
                  : kind === "learned"
                    ? refreshMemoryLearnedStatus()
                    : refreshMemoryClearStatus()).catch(() => undefined)}
              >
                <RotateCw className="size-4" aria-hidden="true" />
                {t(locale, "refresh")}
              </button>
            ) : (
              <button className={secondaryButton} type="button" onClick={() => dismissMemoryOperationStatus(kind)}>
                {t(locale, "dismiss")}
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function UnresolvedStatus({
  kind,
  locale
}: {
  kind: DeletionKind | "rebuild";
  locale: MemoryUiLocale;
}) {
  const error = useMemoryOperationsStore((state) =>
    kind === "all"
      ? state.allError
      : kind === "clear"
      ? state.clearError
      : kind === "learned" ? state.learnedError : state.rebuildError
  );
  const loadState = useMemoryOperationsStore((state) =>
    kind === "all"
      ? state.allLoadState
      : kind === "clear"
      ? state.clearLoadState
      : kind === "learned" ? state.learnedLoadState : state.rebuildLoadState
  );
  const status = useMemoryOperationsStore((state) =>
    kind === "all"
      ? state.allStatus
      : kind === "clear"
      ? state.clearStatus
      : kind === "learned" ? state.learnedStatus : state.rebuildStatus
  );
  if (!error || status) return null;
  return (
    <section className="border-y border-critical/30 py-4" aria-live="polite">
      <div className="flex items-start gap-3">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-critical" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold text-ink">
            {kind === "all"
              ? t(locale, "allStatusHeading")
              : kind === "clear"
              ? t(locale, "clearStatusHeading")
              : t(locale, kind === "learned" ? "learnedStatusHeading" : "rebuildStatusHeading")}
          </h4>
          <p className="mt-2 text-sm leading-6 text-critical" role="alert">
            {errorText(locale, error)}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className={secondaryButton}
              disabled={loadState === "loading"}
              type="button"
              onClick={() => void (kind === "all"
                ? refreshMemoryAllStatus()
                : kind === "clear"
                ? refreshMemoryClearStatus()
                : kind === "learned"
                  ? refreshMemoryLearnedStatus()
                  : refreshMemoryRebuildStatus()).catch(() => undefined)}
            >
              {loadState === "loading"
                ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                : <RotateCw className="size-4" aria-hidden="true" />}
              {t(locale, "refresh")}
            </button>
            <button
              className={secondaryButton}
              type="button"
              onClick={() => dismissMemoryOperationStatus(kind)}
            >
              {t(locale, "dismissReference")}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

type MaintenanceOperation = Exclude<
  MemoryOperationsAction,
  "CLEAR_HISTORY_INDEX" | "DELETE_ALL_REUSABLE" | "DELETE_LEARNED"
>;

function operationUnavailableReason(
  data: MemorySettingsResponse,
  operation: MaintenanceOperation
): MemoryOperationsUiCopyKey | null {
  if (!data.capabilities.historyRecall) return "historyUnavailable";
  if (!data.settings.referenceChatHistory) return "historyOff";
  if (operation === "REEMBED" && !data.settings.embeddingDeployment) {
    return "embeddingUnavailable";
  }
  if (
    operation === "REDREAM_EXISTING_CHATS" &&
    (!data.capabilities.automaticLearning || !data.egress.systemModelDestination)
  ) return "learningUnavailable";
  if (
    (operation === "REEMBED" || operation === "REDREAM_EXISTING_CHATS") &&
    data.egress.reviewRequired
  ) return "consentRequired";
  return null;
}

function OperationRow({
  data,
  description,
  icon,
  label,
  locale,
  operation
}: {
  data: MemorySettingsResponse;
  description: string;
  icon: ReactNode;
  label: string;
  locale: MemoryUiLocale;
  operation: MaintenanceOperation;
}) {
  const busy = useMemoryOperationsStore((state) => state.busy);
  const rebuildStatus = useMemoryOperationsStore((state) => state.rebuildStatus);
  const unavailable = operationUnavailableReason(data, operation);
  const active = rebuildStatus &&
    !["CANCELLED", "FAILED", "STALE", "SUCCEEDED"].includes(rebuildStatus.state);
  return (
    <li className="py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-control bg-control-selected text-proof">
            {icon}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">{label}</p>
            <p className="mt-1 text-xs leading-5 text-ink-muted">{description}</p>
            <p className={`mt-1 text-xs font-semibold ${unavailable ? "text-caution" : "text-positive"}`}>
              {unavailable ? `${t(locale, "unavailable")}: ${t(locale, unavailable)}` : t(locale, "available")}
            </p>
          </div>
        </div>
        <button
          className={`${secondaryButton} shrink-0`}
          disabled={Boolean(unavailable || active || busy)}
          type="button"
          onClick={() => selectMemoryOperation(operation)}
        >
          {t(locale, "runAction")}
        </button>
      </div>
    </li>
  );
}

function DestructiveRow({
  active,
  description,
  heading,
  icon,
  label,
  locale,
  operation,
  retention
}: {
  active: boolean;
  description: string;
  heading: string;
  icon: ReactNode;
  label: string;
  locale: MemoryUiLocale;
  operation: "CLEAR_HISTORY_INDEX" | "DELETE_ALL_REUSABLE" | "DELETE_LEARNED";
  retention: string;
}) {
  const busy = useMemoryOperationsStore((state) => state.busy);
  return (
    <li className="py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-control bg-critical/10 text-critical">
            {icon}
          </span>
          <div className="min-w-0">
            <h4 className="text-sm font-semibold text-ink">{heading}</h4>
            <p className="mt-1 text-sm font-semibold text-critical">{label}</p>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-ink-secondary">{description}</p>
            <details className="mt-2 max-w-2xl border-y border-trace-subtle py-1">
              <summary className={`min-h-control cursor-pointer py-2 text-xs font-semibold text-ink-secondary ${focusRing}`}>
                {t(locale, "deletionDetails")}
              </summary>
              <p className="pb-2 text-xs leading-5 text-ink-muted">{retention}</p>
            </details>
          </div>
        </div>
        <button
          className={`${destructiveButton} shrink-0`}
          disabled={Boolean(busy || active)}
          type="button"
          onClick={() => selectMemoryOperation(operation)}
        >
          <ShieldAlert className="size-4" aria-hidden="true" />
          {t(locale, "runAction")}
        </button>
      </div>
    </li>
  );
}

function Confirmation({ locale, operation }: {
  locale: MemoryUiLocale;
  operation: MemoryOperationsAction;
}) {
  const busy = useMemoryOperationsStore((state) => state.busy);
  const error = useMemoryOperationsStore((state) => state.confirmationError);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const heading = headingRef.current;
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView?.({ block: "nearest" });
  }, [operation]);
  const destructive = operation === "CLEAR_HISTORY_INDEX" ||
    operation === "DELETE_ALL_REUSABLE" || operation === "DELETE_LEARNED";
  const deletionCopy = operation === "DELETE_LEARNED"
    ? {
        fence: "learnedFence" as const,
        future: "learnedFuture" as const,
        retention: "learnedRetention" as const
      }
    : operation === "DELETE_ALL_REUSABLE"
      ? {
          fence: "allFence" as const,
          future: "allFuture" as const,
          retention: "allRetention" as const
        }
    : {
        fence: "clearFence" as const,
        future: "clearFuture" as const,
        retention: "clearRetention" as const
      };
  return (
    <section className={`mt-6 border-y px-3 py-4 ${destructive ? "border-critical/35 bg-critical/5" : "border-trace-subtle bg-control-surface/40"}`} aria-labelledby="memory-operation-confirmation-heading">
      <div className="flex items-start gap-3">
        {destructive
          ? <ShieldAlert className="mt-0.5 size-5 shrink-0 text-critical" aria-hidden="true" />
          : <Fingerprint className="mt-0.5 size-5 shrink-0 text-proof" aria-hidden="true" />}
        <div className="min-w-0 flex-1">
          <h3
            className="text-base font-semibold text-ink"
            id="memory-operation-confirmation-heading"
            ref={headingRef}
            tabIndex={-1}
          >
            {t(locale, "confirmationTitle")}
          </h3>
          <p className="mt-2 text-xs font-semibold uppercase tracking-[0.08em] text-ink-muted">
            {t(locale, "confirmationOperation")}
          </p>
          <p className="mt-1 text-sm font-semibold text-ink">{operationLabel(locale, operation)}</p>
          <p className="mt-2 text-sm leading-6 text-ink-secondary">{confirmationText(locale, operation)}</p>
          {destructive ? (
            <details className="mt-3 border-y border-trace-subtle py-1">
              <summary className={`min-h-control cursor-pointer py-2 text-xs font-semibold text-ink-secondary ${focusRing}`}>
                {t(locale, "deletionDetails")}
              </summary>
              <div className="space-y-2 pb-3 text-xs leading-5 text-ink-secondary">
                <p>{t(locale, deletionCopy.fence)}</p>
                <p>{t(locale, deletionCopy.retention)}</p>
                <p>{t(locale, deletionCopy.future)}</p>
              </div>
            </details>
          ) : (
            <p className="mt-3 text-xs leading-5 text-ink-muted">{t(locale, "servedGeneration")}</p>
          )}
          {error ? <p className="mt-3 text-sm text-critical" role="alert">{errorText(locale, error)}</p> : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              className={secondaryButton}
              disabled={busy !== null}
              type="button"
              onClick={() => selectMemoryOperation(null)}
            >
              {t(locale, "confirmationCancel")}
            </button>
            <button
              className={destructive ? destructiveButton : primaryButton}
              disabled={busy !== null}
              type="button"
              onClick={() => void confirmSelectedMemoryOperation().catch(() => undefined)}
            >
              {busy === "admitting"
                ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                : destructive
                  ? <Eraser className="size-4" aria-hidden="true" />
                  : <Check className="size-4" aria-hidden="true" />}
              {busy === "admitting" ? t(locale, "admitting") : t(locale, "confirmationCommit")}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

export function MemoryOperations({
  data,
  locale,
  onBack
}: {
  data: MemorySettingsResponse;
  locale: MemoryUiLocale;
  onBack(): void;
}) {
  const confirmation = useMemoryOperationsStore((state) => state.confirmation);
  const allError = useMemoryOperationsStore((state) => state.allError);
  const allStatus = useMemoryOperationsStore((state) => state.allStatus);
  const clearError = useMemoryOperationsStore((state) => state.clearError);
  const clearStatus = useMemoryOperationsStore((state) => state.clearStatus);
  const learnedError = useMemoryOperationsStore((state) => state.learnedError);
  const learnedStatus = useMemoryOperationsStore((state) => state.learnedStatus);
  const rebuildError = useMemoryOperationsStore((state) => state.rebuildError);
  const rebuildStatus = useMemoryOperationsStore((state) => state.rebuildStatus);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => headingRef.current?.focus({ preventScroll: true }), []);
  useEffect(() => {
    if (!allStatus || ["CANCELLED", "SUCCEEDED"].includes(allStatus.state)) return;
    const delay = allStatus.state === "BLOCKED_REQUIRES_ADMIN"
      ? 30_000
      : allStatus.state === "RETRY_WAIT" ? 5_000 : 1_500;
    const timer = window.setTimeout(() => {
      void refreshMemoryAllStatus(allStatus.deletionId).catch(() => undefined);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [allStatus]);
  useEffect(() => {
    if (!clearStatus || ["CANCELLED", "SUCCEEDED"].includes(clearStatus.state)) return;
    const delay = clearStatus.state === "BLOCKED_REQUIRES_ADMIN"
      ? 30_000
      : clearStatus.state === "RETRY_WAIT" ? 5_000 : 1_500;
    const timer = window.setTimeout(() => {
      void refreshMemoryClearStatus(clearStatus.deletionId).catch(() => undefined);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [clearStatus]);
  useEffect(() => {
    if (!learnedStatus || ["CANCELLED", "SUCCEEDED"].includes(learnedStatus.state)) return;
    const delay = learnedStatus.state === "BLOCKED_REQUIRES_ADMIN"
      ? 30_000
      : learnedStatus.state === "RETRY_WAIT" ? 5_000 : 1_500;
    const timer = window.setTimeout(() => {
      void refreshMemoryLearnedStatus(learnedStatus.deletionId).catch(() => undefined);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [learnedStatus]);
  useEffect(() => {
    if (
      !rebuildStatus ||
      ["CANCELLED", "FAILED", "STALE", "SUCCEEDED"].includes(rebuildStatus.state)
    ) return;
    const delay = rebuildStatus.state === "WAITING_FOR_EGRESS_CONSENT" ? 5_000 : 1_500;
    const timer = window.setTimeout(() => {
      void refreshMemoryRebuildStatus(rebuildStatus.jobId).catch(() => undefined);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [rebuildStatus]);

  function back() {
    selectMemoryOperation(null);
    onBack();
  }

  const allActive = allStatus && !["CANCELLED", "SUCCEEDED"].includes(allStatus.state);
  const clearActive = clearStatus && !["CANCELLED", "SUCCEEDED"].includes(clearStatus.state);
  const learnedActive = learnedStatus && !["CANCELLED", "SUCCEEDED"].includes(learnedStatus.state);

  return (
    <div className="mx-auto w-full max-w-4xl" data-testid="memory-operations">
      <header className="border-b border-trace-subtle pb-4">
        <button className={`${quietButton} -ml-2`} onClick={back} type="button">
          <ArrowLeft className="size-4" aria-hidden="true" />
          {t(locale, "back")}
        </button>
        <div className="mt-2 flex items-start gap-3">
          <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-control bg-control-selected text-proof">
            <DatabaseZap className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 ref={headingRef} className="text-lg font-semibold text-ink" tabIndex={-1}>
              {t(locale, "title")}
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-secondary">
              {t(locale, "intro")}
            </p>
          </div>
        </div>
      </header>

      {confirmation ? <Confirmation locale={locale} operation={confirmation} /> : null}

      {(allStatus || clearStatus || learnedStatus || rebuildStatus ||
        allError || clearError || learnedError || rebuildError) ? (
        <div className="mt-6" aria-labelledby="memory-operation-status-heading">
          <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-muted" id="memory-operation-status-heading">
            {t(locale, "statusHeading")}
          </h3>
          <div className="mt-2 space-y-4">
            <RebuildStatus locale={locale} />
            <DeletionStatus kind="all" locale={locale} />
            <DeletionStatus kind="learned" locale={locale} />
            <DeletionStatus kind="clear" locale={locale} />
            <UnresolvedStatus kind="rebuild" locale={locale} />
            <UnresolvedStatus kind="all" locale={locale} />
            <UnresolvedStatus kind="learned" locale={locale} />
            <UnresolvedStatus kind="clear" locale={locale} />
          </div>
        </div>
      ) : null}

      <section className="mt-7" aria-labelledby="memory-maintenance-heading">
        <h3 className="text-sm font-semibold text-ink" id="memory-maintenance-heading">
          {t(locale, "maintenanceHeading")}
        </h3>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-ink-muted">
          {t(locale, "maintenanceDescription")}
        </p>
        {!data.settings.embeddingDeployment ? (
          <div className="mt-3 flex items-start gap-2 border-l-2 border-caution bg-caution/10 px-3 py-2 text-xs leading-5 text-ink-secondary" role="status">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-caution" aria-hidden="true" />
            <span>{t(locale, "lexicalOnly")}</span>
          </div>
        ) : null}
        <ul className="mt-3 divide-y divide-trace-subtle border-y border-trace-subtle">
          <OperationRow
            data={data}
            description={t(locale, "rebuildDescription")}
            icon={<RefreshCw className="size-4" aria-hidden="true" />}
            label={t(locale, "rebuildLabel")}
            locale={locale}
            operation="REBUILD_SEARCH_INDEX"
          />
          <OperationRow
            data={data}
            description={t(locale, "reembedDescription")}
            icon={<DatabaseZap className="size-4" aria-hidden="true" />}
            label={t(locale, "reembedLabel")}
            locale={locale}
            operation="REEMBED"
          />
          <OperationRow
            data={data}
            description={t(locale, "redreamDescription")}
            icon={<Sparkles className="size-4" aria-hidden="true" />}
            label={t(locale, "redreamLabel")}
            locale={locale}
            operation="REDREAM_EXISTING_CHATS"
          />
        </ul>
        <p className="mt-3 text-xs leading-5 text-ink-muted">{t(locale, "servedGeneration")}</p>
      </section>

      <section className="mt-7" aria-labelledby="memory-destructive-heading">
        <h3 className="text-sm font-semibold text-ink" id="memory-destructive-heading">
          {t(locale, "destructiveHeading")}
        </h3>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-ink-muted">
          {t(locale, "destructiveDescription")}
        </p>
        <ul className="mt-3 divide-y divide-critical/20 border-y border-critical/25">
          <DestructiveRow
            active={Boolean(allActive || learnedActive || clearActive)}
            description={t(locale, "allDescription")}
            heading={t(locale, "allHeading")}
            icon={<Eraser className="size-4" aria-hidden="true" />}
            label={t(locale, "allLabel")}
            locale={locale}
            operation="DELETE_ALL_REUSABLE"
            retention={t(locale, "allRetention")}
          />
          <DestructiveRow
            active={Boolean(learnedActive || allActive)}
            description={t(locale, "learnedDescription")}
            heading={t(locale, "learnedHeading")}
            icon={<Fingerprint className="size-4" aria-hidden="true" />}
            label={t(locale, "learnedLabel")}
            locale={locale}
            operation="DELETE_LEARNED"
            retention={t(locale, "learnedRetention")}
          />
          <DestructiveRow
            active={Boolean(clearActive || allActive)}
            description={t(locale, "clearDescription")}
            heading={t(locale, "clearHeading")}
            icon={<DatabaseZap className="size-4" aria-hidden="true" />}
            label={t(locale, "clearLabel")}
            locale={locale}
            operation="CLEAR_HISTORY_INDEX"
            retention={t(locale, "clearRetention")}
          />
        </ul>
      </section>
    </div>
  );
}
