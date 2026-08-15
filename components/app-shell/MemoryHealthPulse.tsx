import {
  memoryHealthStateCopy,
  memoryHealthUiCopy
} from "@/components/app-shell/memoryHealthUiCopy";
import type { UserMemoryHealth } from "@/lib/contracts/memoryHealth";
import {
  Check,
  CircleAlert,
  Clock3,
  DatabaseZap,
  LoaderCircle,
  RefreshCw,
  Search
} from "lucide-react";
import type { ReactNode, RefObject } from "react";

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-overlay-surface";
const actionButton =
  `inline-flex min-h-touch items-center justify-center gap-2 rounded-control border border-trace-subtle bg-control-surface px-3 text-sm font-semibold text-ink-secondary hover:bg-control-hover hover:text-ink ${focusRing}`;

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function stateTone(state: UserMemoryHealth["state"]): Readonly<{
  border: string;
  Icon: typeof Check;
  icon: string;
}> {
  switch (state) {
    case "UP_TO_DATE": return { border: "border-positive", Icon: Check, icon: "text-positive" };
    case "INDEXING": return { border: "border-proof", Icon: LoaderCircle, icon: "text-proof" };
    case "FTS_ONLY": return { border: "border-caution", Icon: Search, icon: "text-caution" };
    case "LEARNING_DELAYED": return { border: "border-caution", Icon: Clock3, icon: "text-caution" };
    case "DELETION_IN_PROGRESS": return { border: "border-caution", Icon: DatabaseZap, icon: "text-caution" };
    case "REBUILD_FAILED":
    case "TEMPORARY_OVERDUE":
    case "BLOCKED_REQUIRES_ADMIN":
      return { border: "border-critical", Icon: CircleAlert, icon: "text-critical" };
  }
}

function operationalValue(
  state: "BLOCKED" | "CLEAR" | "DELAYED" | "DISABLED" | "FAILED" |
    "FTS_ONLY" | "IN_PROGRESS" | "OVERDUE" | "READY"
): string {
  const key = {
    BLOCKED: "stateBlocked",
    CLEAR: "stateClear",
    DELAYED: "stateDelayed",
    DISABLED: "stateDisabled",
    FAILED: "stateFailed",
    FTS_ONLY: "stateFtsOnly",
    IN_PROGRESS: "stateInProgress",
    OVERDUE: "stateOverdue",
    READY: "stateReady"
  } as const;
  return memoryHealthUiCopy(key[state]);
}

export function MemoryHealthPulse({
  error,
  health,
  loading,
  advancedContent,
  onOpenOperations,
  onRetry,
  operationsButtonRef
}: Readonly<{
  error: boolean;
  health: UserMemoryHealth | null;
  loading: boolean;
  advancedContent?: ReactNode;
  onOpenOperations(): void;
  onRetry(): void;
  operationsButtonRef?: RefObject<HTMLButtonElement | null>;
}>) {
  const copy = (key: Parameters<typeof memoryHealthUiCopy>[0]) =>
    memoryHealthUiCopy(key);

  if (!health && loading) {
    return (
      <div className="mt-5 flex items-center gap-2 border-l-2 border-proof/60 bg-proof/[0.04] px-3 py-3 text-sm text-ink-secondary" role="status">
        <LoaderCircle className="size-4 animate-spin text-proof motion-reduce:animate-none" aria-hidden="true" />
        {copy("checking")}
      </div>
    );
  }
  if (!health) {
    return (
      <div className="mt-5 border-l-2 border-critical bg-critical/10 px-3 py-3" role="alert">
        <div className="flex items-start gap-2">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-critical" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold text-ink">{copy("unavailableTitle")}</p>
            <p className="mt-1 text-xs leading-5 text-ink-secondary">{copy("unavailableDescription")}</p>
          </div>
        </div>
        <button className={`${actionButton} mt-3`} onClick={onRetry} type="button">
          <RefreshCw className="size-4" aria-hidden="true" />
          {copy("retry")}
        </button>
      </div>
    );
  }

  const tone = stateTone(health.state);
  const StatusIcon = tone.Icon;
  const stateCopy = memoryHealthStateCopy(health);
  const critical = health.state === "BLOCKED_REQUIRES_ADMIN" ||
    health.state === "TEMPORARY_OVERDUE";
  const indexingProgress = health.state === "INDEXING" &&
    health.indexing.totalChats > 0
    ? `${health.indexing.completedChats} / ${health.indexing.totalChats}${health.indexing.countTruncated ? "+" : ""}`
    : null;
  const learningState = health.learning.state === "DISABLED"
    ? "DISABLED"
    : health.learning.state === "DELAYED" ? "DELAYED" : "READY";
  const indexingState = health.indexing.state === "DISABLED"
    ? "DISABLED"
    : health.indexing.state === "INDEXING"
      ? "IN_PROGRESS"
      : health.indexing.state === "FTS_ONLY" ? "FTS_ONLY" : "READY";
  const rebuildState = health.rebuild.state === "FAILED"
    ? "FAILED"
    : health.rebuild.state === "IN_PROGRESS" ? "IN_PROGRESS" : "READY";
  const deletionState = health.deletion.state === "BLOCKED_REQUIRES_ADMIN"
    ? "BLOCKED"
    : health.deletion.state === "IN_PROGRESS" ? "IN_PROGRESS" : "CLEAR";

  return (
    <section
      className={`mt-5 border-l-2 ${tone.border} bg-control-surface/60 px-3 py-3`}
      aria-labelledby="memory-health-title"
      aria-live={critical ? "assertive" : "polite"}
      data-testid="memory-health-pulse"
    >
      <div className="flex items-start gap-3">
        <StatusIcon
          className={`mt-0.5 size-4 shrink-0 ${tone.icon} ${health.state === "INDEXING" ? "animate-spin motion-reduce:animate-none" : ""}`}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h4 className="text-sm font-semibold text-ink" id="memory-health-title">{stateCopy.title}</h4>
            {indexingProgress ? <span className="text-xs font-semibold text-proof">{indexingProgress}</span> : null}
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-ink-secondary">{stateCopy.description}</p>
          {health.state === "BLOCKED_REQUIRES_ADMIN" && health.temporary.state === "OVERDUE" ? (
            <p className="mt-2 text-xs font-semibold text-critical">{copy("alsoTemporaryOverdue")}</p>
          ) : null}
          {health.action === "OPEN_MEMORY_OPERATIONS" ? (
            <button
              className={`${actionButton} mt-3`}
              onClick={onOpenOperations}
              ref={operationsButtonRef}
              type="button"
            >
              <DatabaseZap className="size-4" aria-hidden="true" />
              {copy("openOperations")}
            </button>
          ) : null}
        </div>
      </div>

      <details className="mt-3 border-t border-trace-subtle pt-2">
        <summary className={`min-h-touch cursor-pointer select-none py-2 text-xs font-semibold text-ink-secondary hover:text-ink ${focusRing}`}>
          {copy("advanced")}
        </summary>
        <p className="pb-2 text-xs leading-5 text-ink-muted">{copy("advancedDescription")}</p>
        <dl className="divide-y divide-trace-subtle text-xs">
          <div className="flex items-center justify-between gap-4 py-2"><dt className="text-ink-muted">{copy("learning")}</dt><dd className="font-medium text-ink-secondary">{operationalValue(learningState)}</dd></div>
          <div className="flex items-center justify-between gap-4 py-2"><dt className="text-ink-muted">{copy("indexing")}</dt><dd className="font-medium text-ink-secondary">{operationalValue(indexingState)}</dd></div>
          <div className="flex items-center justify-between gap-4 py-2"><dt className="text-ink-muted">{copy("rebuild")}</dt><dd className="font-medium text-ink-secondary">{operationalValue(rebuildState)}</dd></div>
          <div className="flex items-center justify-between gap-4 py-2"><dt className="text-ink-muted">{copy("cleanup")}</dt><dd className="font-medium text-ink-secondary">{operationalValue(deletionState)}</dd></div>
          <div className="flex items-center justify-between gap-4 py-2"><dt className="text-ink-muted">{copy("temporaryCleanup")}</dt><dd className="font-medium text-ink-secondary">{operationalValue(health.temporary.state === "OVERDUE" ? "OVERDUE" : "CLEAR")}</dd></div>
          <div className="flex items-center justify-between gap-4 py-2"><dt className="text-ink-muted">{copy("egress")}</dt><dd className="font-medium text-ink-secondary">{health.egressReview === "ADMIN_REQUIRED" ? copy("stateAdminReview") : health.egressReview === "USER_REQUIRED" ? copy("stateUserReview") : copy("stateReady")}</dd></div>
          <div className="flex items-center justify-between gap-4 py-2"><dt className="text-ink-muted">{copy("lastChecked")}</dt><dd className="font-medium text-ink-secondary">{formatDate(health.observedAt)}</dd></div>
        </dl>
        {advancedContent}
        {error ? (
          <button className={`${actionButton} mt-3`} onClick={onRetry} type="button">
            <RefreshCw className="size-4" aria-hidden="true" />
            {copy("retry")}
          </button>
        ) : null}
      </details>
    </section>
  );
}
