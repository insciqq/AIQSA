import {
  cancelActiveMemoryRebuild,
  confirmSelectedMemoryOperation,
  dismissMemoryOperationStatus,
  refreshMemoryClearStatus,
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
  return new Intl.DateTimeFormat(locale === "RU" ? "ru-RU" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function operationLabel(locale: MemoryUiLocale, operation: MemoryOperationsAction): string {
  switch (operation) {
    case "REBUILD_SEARCH_INDEX": return t(locale, "rebuildLabel");
    case "REEMBED": return t(locale, "reembedLabel");
    case "REDREAM_EXISTING_CHATS": return t(locale, "redreamLabel");
    case "CLEAR_HISTORY_INDEX": return t(locale, "clearLabel");
  }
}

function confirmationText(locale: MemoryUiLocale, operation: MemoryOperationsAction): string {
  switch (operation) {
    case "REBUILD_SEARCH_INDEX": return t(locale, "confirmationRebuild");
    case "REEMBED": return t(locale, "confirmationReembed");
    case "REDREAM_EXISTING_CHATS": return t(locale, "confirmationRedream");
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

function clearStateText(locale: MemoryUiLocale, status: MemoryDeletionStatus): string {
  switch (status.state) {
    case "PENDING": return t(locale, "statePending");
    case "RUNNING": return t(locale, "stateClearRunning");
    case "RETRY_WAIT": return t(locale, "stateRetry");
    case "BLOCKED_REQUIRES_ADMIN": return t(locale, "stateBlocked");
    case "SUCCEEDED": return t(locale, "stateClearSucceeded");
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

function ClearStatus({ locale }: { locale: MemoryUiLocale }) {
  const error = useMemoryOperationsStore((state) => state.clearError);
  const loadState = useMemoryOperationsStore((state) => state.clearLoadState);
  const status = useMemoryOperationsStore((state) => state.clearStatus);
  if (!status) return null;
  const blocked = status.state === "BLOCKED_REQUIRES_ADMIN";
  const succeeded = status.state === "SUCCEEDED";
  return (
    <section className="border-y border-trace-subtle py-4" aria-labelledby="memory-clear-status-heading">
      <div className="flex items-start gap-3">
        <Eraser className={`mt-0.5 size-4 shrink-0 ${blocked ? "text-critical" : succeeded ? "text-positive" : "text-caution"}`} aria-hidden="true" />
        <div className="min-w-0 flex-1" aria-live="polite" aria-busy={loadState === "loading"}>
          <h4 className="text-sm font-semibold text-ink" id="memory-clear-status-heading">
            {t(locale, "clearStatusHeading")}
          </h4>
          <p className={`mt-2 text-sm leading-6 ${blocked ? "text-critical" : "text-ink-secondary"}`}>
            {clearStateText(locale, status)}
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
            {!succeeded ? (
              <button
                className={secondaryButton}
                disabled={loadState === "loading"}
                type="button"
                onClick={() => void refreshMemoryClearStatus().catch(() => undefined)}
              >
                <RotateCw className="size-4" aria-hidden="true" />
                {t(locale, "refresh")}
              </button>
            ) : (
              <button className={secondaryButton} type="button" onClick={() => dismissMemoryOperationStatus("clear")}>
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
  kind: "clear" | "rebuild";
  locale: MemoryUiLocale;
}) {
  const error = useMemoryOperationsStore((state) =>
    kind === "clear" ? state.clearError : state.rebuildError
  );
  const loadState = useMemoryOperationsStore((state) =>
    kind === "clear" ? state.clearLoadState : state.rebuildLoadState
  );
  const status = useMemoryOperationsStore((state) =>
    kind === "clear" ? state.clearStatus : state.rebuildStatus
  );
  if (!error || status) return null;
  return (
    <section className="border-y border-critical/30 py-4" aria-live="polite">
      <div className="flex items-start gap-3">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-critical" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold text-ink">
            {kind === "clear" ? t(locale, "clearStatusHeading") : t(locale, "rebuildStatusHeading")}
          </h4>
          <p className="mt-2 text-sm leading-6 text-critical" role="alert">
            {errorText(locale, error)}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className={secondaryButton}
              disabled={loadState === "loading"}
              type="button"
              onClick={() => void (kind === "clear"
                ? refreshMemoryClearStatus()
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

function operationUnavailableReason(
  data: MemorySettingsResponse,
  operation: Exclude<MemoryOperationsAction, "CLEAR_HISTORY_INDEX">
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
  operation: Exclude<MemoryOperationsAction, "CLEAR_HISTORY_INDEX">;
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
  const destructive = operation === "CLEAR_HISTORY_INDEX";
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
            <div className="mt-3 space-y-2 text-xs leading-5 text-ink-secondary">
              <p>{t(locale, "clearFence")}</p>
              <p>{t(locale, "clearRetention")}</p>
              <p>{t(locale, "clearFuture")}</p>
            </div>
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
  const busy = useMemoryOperationsStore((state) => state.busy);
  const clearError = useMemoryOperationsStore((state) => state.clearError);
  const clearStatus = useMemoryOperationsStore((state) => state.clearStatus);
  const rebuildError = useMemoryOperationsStore((state) => state.rebuildError);
  const rebuildStatus = useMemoryOperationsStore((state) => state.rebuildStatus);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => headingRef.current?.focus({ preventScroll: true }), []);
  useEffect(() => {
    if (!clearStatus || clearStatus.state === "SUCCEEDED") return;
    const delay = clearStatus.state === "BLOCKED_REQUIRES_ADMIN"
      ? 30_000
      : clearStatus.state === "RETRY_WAIT" ? 5_000 : 1_500;
    const timer = window.setTimeout(() => {
      void refreshMemoryClearStatus(clearStatus.deletionId).catch(() => undefined);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [clearStatus]);
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

  const clearActive = clearStatus && clearStatus.state !== "SUCCEEDED";

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

      {(clearStatus || rebuildStatus || clearError || rebuildError) ? (
        <div className="mt-6" aria-labelledby="memory-operation-status-heading">
          <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-muted" id="memory-operation-status-heading">
            {t(locale, "statusHeading")}
          </h3>
          <div className="mt-2 space-y-4">
            <RebuildStatus locale={locale} />
            <ClearStatus locale={locale} />
            <UnresolvedStatus kind="rebuild" locale={locale} />
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

      <section className="mt-7 border-y border-critical/25 py-4" aria-labelledby="memory-clear-heading">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-ink" id="memory-clear-heading">
              {t(locale, "clearHeading")}
            </h3>
            <p className="mt-2 text-sm font-semibold text-critical">{t(locale, "clearLabel")}</p>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-ink-secondary">
              {t(locale, "clearDescription")}
            </p>
            <p className="mt-2 max-w-2xl text-xs leading-5 text-ink-muted">
              {t(locale, "clearRetention")}
            </p>
          </div>
          <button
            className={`${destructiveButton} shrink-0`}
            disabled={Boolean(busy || clearActive)}
            type="button"
            onClick={() => selectMemoryOperation("CLEAR_HISTORY_INDEX")}
          >
            <ShieldAlert className="size-4" aria-hidden="true" />
            {t(locale, "runAction")}
          </button>
        </div>
      </section>
    </div>
  );
}
