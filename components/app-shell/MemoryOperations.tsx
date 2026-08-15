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
  MemorySettingsResponse
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

function t(key: MemoryOperationsUiCopyKey): string {
  return memoryOperationsUiCopy(key);
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function operationLabel(operation: MemoryOperationsAction): string {
  switch (operation) {
    case "REBUILD_SEARCH_INDEX": return t("rebuildLabel");
    case "REEMBED": return t("reembedLabel");
    case "DELETE_ALL_REUSABLE": return t("allLabel");
    case "DELETE_LEARNED": return t("learnedLabel");
    case "CLEAR_HISTORY_INDEX": return t("clearLabel");
  }
}

function confirmationText(operation: MemoryOperationsAction): string {
  switch (operation) {
    case "REBUILD_SEARCH_INDEX": return t("confirmationRebuild");
    case "REEMBED": return t("confirmationReembed");
    case "DELETE_ALL_REUSABLE": return t("confirmationAll");
    case "DELETE_LEARNED": return t("confirmationLearned");
    case "CLEAR_HISTORY_INDEX": return t("confirmationClear");
  }
}

function errorText(code: string | null): string {
  switch (code) {
    case "memory_version_stale": return t("errorStale");
    case "memory_egress_consent_required": return t("errorConsent");
    case "memory_embedding_unavailable": return t("errorEmbedding");
    case "memory_rebuild_in_progress": return t("errorInProgress");
    case "memory_intent_confirmation_required": return t("errorConfirmation");
    case "memory_deletion_reference_mismatch": return t("errorReferenceMismatch");
    case "memory_rebuild_not_found": return t("errorNotFound");
    default: return t("errorGeneric");
  }
}

function rebuildStateText(status: MemoryRebuildStatus): string {
  switch (status.state) {
    case "QUEUED": return t("stateQueued");
    case "RUNNING": return t("stateRebuildRunning");
    case "WAITING_FOR_EGRESS_CONSENT": return t("stateWaitingConsent");
    case "CATCHING_UP": return t("stateCatchingUp");
    case "READY": return t("stateReady");
    case "SUCCEEDED": return t("stateRebuildSucceeded");
    case "FAILED": return t("stateFailed");
    case "STALE": return t("stateStale");
    case "CANCELLED": return t("stateCancelled");
  }
}

type DeletionKind = "all" | "clear" | "learned";

function deletionStateText(
  kind: DeletionKind,
  status: MemoryDeletionStatus
): string {
  switch (status.state) {
    case "PENDING": return t(kind === "all" ? "stateAllPending" : "statePending");
    case "RUNNING": return t(kind === "all"
      ? "stateAllRunning"
      : kind === "learned" ? "stateLearnedRunning" : "stateClearRunning");
    case "RETRY_WAIT": return t(kind === "all"
      ? "stateAllRetry"
      : kind === "learned" ? "stateLearnedRetry" : "stateRetry");
    case "BLOCKED_REQUIRES_ADMIN": return t(kind === "all"
      ? "stateAllBlocked"
      : kind === "learned" ? "stateLearnedBlocked" : "stateBlocked");
    case "SUCCEEDED": return t(kind === "all"
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
  reference,
  updatedAt,
  auditAt
}: {
  auditAt?: string | null;
  reference: string;
  updatedAt: string;
}) {
  return (
    <dl className="mt-3 divide-y divide-trace-subtle text-xs">
      <div className="grid gap-1 py-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
        <dt className="font-medium text-ink-muted">{t("reference")}</dt>
        <dd><code className="break-all font-mono text-ink-secondary">{reference}</code></dd>
      </div>
      <div className="grid gap-1 py-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
        <dt className="font-medium text-ink-muted">{t("updated")}</dt>
        <dd className="text-ink-secondary">{formatDate(updatedAt)}</dd>
      </div>
      {auditAt !== undefined ? (
        <div className="grid gap-1 py-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <dt className="font-medium text-ink-muted">{t("lastAudit")}</dt>
          <dd className="text-ink-secondary">{formatDate(auditAt)}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function RebuildStatus() {
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
            {t("rebuildStatusHeading")}
          </h4>
          <p className="mt-1 text-xs font-semibold text-ink-secondary">
            {operationLabel(status.operation)}
          </p>
          <p className={`mt-2 text-sm leading-6 ${failed ? "text-critical" : "text-ink-secondary"}`}>
            {rebuildStateText(status)}
          </p>
          {failed && status.errorCode ? (
            <p className="mt-2 text-sm text-critical" role="alert">{errorText(status.errorCode)}</p>
          ) : null}
          <Progress completed={status.completedUnits} label={t("progress")} total={status.totalUnits} />
          <StatusMetadata reference={status.jobId} updatedAt={status.updatedAt} />
          {error ? <p className="mt-3 text-sm text-critical" role="alert">{errorText(error)}</p> : null}
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
                  {t("refresh")}
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
                  {busy === "cancelling" ? t("cancelling") : t("cancelJob")}
                </button>
              </>
            ) : (
              <button className={secondaryButton} type="button" onClick={() => dismissMemoryOperationStatus("rebuild")}>
                {t("dismiss")}
              </button>
            )}
          </div>
          <p className="mt-3 text-xs leading-5 text-ink-muted">{t("cancelBoundary")}</p>
        </div>
      </div>
    </section>
  );
}

function DeletionStatus({ kind }: {
  kind: DeletionKind;
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
            {t(kind === "all"
              ? "allStatusHeading"
              : kind === "learned" ? "learnedStatusHeading" : "clearStatusHeading")}
          </h4>
          <p className={`mt-2 text-sm leading-6 ${blocked ? "text-critical" : "text-ink-secondary"}`}>
            {deletionStateText(kind, status)}
          </p>
          <Progress completed={status.completedUnits} label={t("progress")} total={status.totalUnits} />
          <StatusMetadata
            auditAt={status.lastAuditAt}
            reference={status.deletionId}
            updatedAt={status.updatedAt}
          />
          {error ? <p className="mt-3 text-sm text-critical" role="alert">{errorText(error)}</p> : null}
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
                {t("refresh")}
              </button>
            ) : (
              <button className={secondaryButton} type="button" onClick={() => dismissMemoryOperationStatus(kind)}>
                {t("dismiss")}
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function UnresolvedStatus({
  kind
}: {
  kind: DeletionKind | "rebuild";
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
              ? t("allStatusHeading")
              : kind === "clear"
              ? t("clearStatusHeading")
              : t(kind === "learned" ? "learnedStatusHeading" : "rebuildStatusHeading")}
          </h4>
          <p className="mt-2 text-sm leading-6 text-critical" role="alert">
            {errorText(error)}
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
              {t("refresh")}
            </button>
            <button
              className={secondaryButton}
              type="button"
              onClick={() => dismissMemoryOperationStatus(kind)}
            >
              {t("dismissReference")}
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
  if (operation === "REEMBED" && data.egress.reviewRequired) return "consentRequired";
  return null;
}

function OperationRow({
  data,
  description,
  icon,
  label,
  operation
}: {
  data: MemorySettingsResponse;
  description: string;
  icon: ReactNode;
  label: string;
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
              {unavailable ? `${t("unavailable")}: ${t(unavailable)}` : t("available")}
            </p>
          </div>
        </div>
        <button
          className={`${secondaryButton} shrink-0`}
          disabled={Boolean(unavailable || active || busy)}
          type="button"
          onClick={() => selectMemoryOperation(operation)}
        >
          {t("runAction")}
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
  operation,
  retention
}: {
  active: boolean;
  description: string;
  heading: string;
  icon: ReactNode;
  label: string;
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
                {t("deletionDetails")}
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
          {t("runAction")}
        </button>
      </div>
    </li>
  );
}

function Confirmation({ operation }: {
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
            {t("confirmationTitle")}
          </h3>
          <p className="mt-2 text-xs font-semibold uppercase tracking-[0.08em] text-ink-muted">
            {t("confirmationOperation")}
          </p>
          <p className="mt-1 text-sm font-semibold text-ink">{operationLabel(operation)}</p>
          <p className="mt-2 text-sm leading-6 text-ink-secondary">{confirmationText(operation)}</p>
          {destructive ? (
            <details className="mt-3 border-y border-trace-subtle py-1">
              <summary className={`min-h-control cursor-pointer py-2 text-xs font-semibold text-ink-secondary ${focusRing}`}>
                {t("deletionDetails")}
              </summary>
              <div className="space-y-2 pb-3 text-xs leading-5 text-ink-secondary">
                <p>{t(deletionCopy.fence)}</p>
                <p>{t(deletionCopy.retention)}</p>
                <p>{t(deletionCopy.future)}</p>
              </div>
            </details>
          ) : (
            <p className="mt-3 text-xs leading-5 text-ink-muted">{t("servedGeneration")}</p>
          )}
          {error ? <p className="mt-3 text-sm text-critical" role="alert">{errorText(error)}</p> : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              className={secondaryButton}
              disabled={busy !== null}
              type="button"
              onClick={() => selectMemoryOperation(null)}
            >
              {t("confirmationCancel")}
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
              {busy === "admitting" ? t("admitting") : t("confirmationCommit")}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

export function MemoryOperations({
  data,
  onBack
}: {
  data: MemorySettingsResponse;
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
          {t("back")}
        </button>
        <div className="mt-2 flex items-start gap-3">
          <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-control bg-control-selected text-proof">
            <DatabaseZap className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 ref={headingRef} className="text-lg font-semibold text-ink" tabIndex={-1}>
              {t("title")}
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-secondary">
              {t("intro")}
            </p>
          </div>
        </div>
      </header>

      {confirmation ? <Confirmation operation={confirmation} /> : null}

      {(allStatus || clearStatus || learnedStatus || rebuildStatus ||
        allError || clearError || learnedError || rebuildError) ? (
        <div className="mt-6" aria-labelledby="memory-operation-status-heading">
          <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-muted" id="memory-operation-status-heading">
            {t("statusHeading")}
          </h3>
          <div className="mt-2 space-y-4">
            <RebuildStatus />
            <DeletionStatus kind="all" />
            <DeletionStatus kind="learned" />
            <DeletionStatus kind="clear" />
            <UnresolvedStatus kind="rebuild" />
            <UnresolvedStatus kind="all" />
            <UnresolvedStatus kind="learned" />
            <UnresolvedStatus kind="clear" />
          </div>
        </div>
      ) : null}

      <section className="mt-7" aria-labelledby="memory-maintenance-heading">
        <h3 className="text-sm font-semibold text-ink" id="memory-maintenance-heading">
          {t("maintenanceHeading")}
        </h3>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-ink-muted">
          {t("maintenanceDescription")}
        </p>
        {!data.settings.embeddingDeployment ? (
          <div className="mt-3 flex items-start gap-2 border-l-2 border-caution bg-caution/10 px-3 py-2 text-xs leading-5 text-ink-secondary" role="status">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-caution" aria-hidden="true" />
            <span>{t("lexicalOnly")}</span>
          </div>
        ) : null}
        <ul className="mt-3 divide-y divide-trace-subtle border-y border-trace-subtle">
          <OperationRow
            data={data}
            description={t("rebuildDescription")}
            icon={<RefreshCw className="size-4" aria-hidden="true" />}
            label={t("rebuildLabel")}
            operation="REBUILD_SEARCH_INDEX"
          />
          <OperationRow
            data={data}
            description={t("reembedDescription")}
            icon={<DatabaseZap className="size-4" aria-hidden="true" />}
            label={t("reembedLabel")}
            operation="REEMBED"
          />
        </ul>
        <p className="mt-3 text-xs leading-5 text-ink-muted">{t("servedGeneration")}</p>
      </section>

      <section className="mt-7" aria-labelledby="memory-destructive-heading">
        <h3 className="text-sm font-semibold text-ink" id="memory-destructive-heading">
          {t("destructiveHeading")}
        </h3>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-ink-muted">
          {t("destructiveDescription")}
        </p>
        <ul className="mt-3 divide-y divide-critical/20 border-y border-critical/25">
          <DestructiveRow
            active={Boolean(allActive || learnedActive || clearActive)}
            description={t("allDescription")}
            heading={t("allHeading")}
            icon={<Eraser className="size-4" aria-hidden="true" />}
            label={t("allLabel")}
            operation="DELETE_ALL_REUSABLE"
            retention={t("allRetention")}
          />
          <DestructiveRow
            active={Boolean(learnedActive || allActive)}
            description={t("learnedDescription")}
            heading={t("learnedHeading")}
            icon={<Fingerprint className="size-4" aria-hidden="true" />}
            label={t("learnedLabel")}
            operation="DELETE_LEARNED"
            retention={t("learnedRetention")}
          />
          <DestructiveRow
            active={Boolean(clearActive || allActive)}
            description={t("clearDescription")}
            heading={t("clearHeading")}
            icon={<DatabaseZap className="size-4" aria-hidden="true" />}
            label={t("clearLabel")}
            operation="CLEAR_HISTORY_INDEX"
            retention={t("clearRetention")}
          />
        </ul>
      </section>
    </div>
  );
}
