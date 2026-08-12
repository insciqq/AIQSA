import { memoryProfileUiCopy } from "@/components/app-shell/memoryProfileUiCopy";
import {
  refreshMemoryProfile,
  useMemoryManagerStore
} from "@/components/app-shell/memoryManagerStore";
import type {
  MemoryProfileContributor,
  MemoryProfileViewState,
  MemoryUiLocale
} from "@/lib/contracts/memory";
import { ChevronDown, Pin, RotateCw, Trash2 } from "lucide-react";
import { useId, useState } from "react";

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-overlay-surface";
const coarsePointerTarget =
  "[@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch";
const quietButton =
  `inline-flex min-h-touch items-center justify-center gap-2 rounded-control px-3 text-sm font-semibold text-ink-secondary hover:bg-control-hover hover:text-ink disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-60 sm:min-h-control ${coarsePointerTarget} ${focusRing}`;
const destructiveQuietButton =
  `inline-flex min-h-touch items-center justify-center gap-2 rounded-control px-3 text-sm font-semibold text-ink-secondary hover:bg-critical/10 hover:text-critical disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-60 sm:min-h-control ${coarsePointerTarget} ${focusRing}`;
const secondaryButton =
  `inline-flex min-h-touch items-center justify-center gap-2 rounded-control border border-trace-subtle bg-control-surface px-3 text-sm font-semibold text-ink-secondary hover:bg-control-hover hover:text-ink disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-60 sm:min-h-control ${coarsePointerTarget} ${focusRing}`;

function t(locale: MemoryUiLocale, key: Parameters<typeof memoryProfileUiCopy>[1]): string {
  return memoryProfileUiCopy(locale, key);
}

function updatedLabel(locale: MemoryUiLocale, value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function priorityLabel(
  locale: MemoryUiLocale,
  value: MemoryProfileContributor["temperatureClass"]
): string {
  if (value === "HOT") return t(locale, "hot");
  if (value === "WARM") return t(locale, "warm");
  return t(locale, "cold");
}

function stateMessage(locale: MemoryUiLocale, state: MemoryProfileViewState): string {
  if (state === "DISABLED") return t(locale, "disabled");
  if (state === "EMPTY") return t(locale, "empty");
  if (state === "PENDING") return t(locale, "pending");
  if (state === "WAITING_FOR_EGRESS_CONSENT") return t(locale, "waiting");
  return t(locale, "unavailable");
}

export function MemoryProfileSummary({
  accountId,
  locale,
  mutationBusy,
  onDelete,
  onEdit,
  onOpenDetails
}: {
  accountId: string;
  locale: MemoryUiLocale;
  mutationBusy: boolean;
  onDelete(contributor: MemoryProfileContributor): Promise<void>;
  onEdit(factId: string): Promise<void>;
  onOpenDetails(factId: string): Promise<void>;
}) {
  const [advancedAccountId, setAdvancedAccountId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<Readonly<{
    accountId: string;
    factId: string;
    kind: "delete" | "edit" | "open";
  }> | null>(null);
  const advancedId = useId();
  const headingId = useId();
  const loadState = useMemoryManagerStore((state) => state.profileLoadState);
  const mutationError = useMemoryManagerStore((state) => state.mutationError);
  const response = useMemoryManagerStore((state) => state.profileResponse);
  const ready = loadState === "ready" && response?.state === "READY" && response.profile
    ? response.profile
    : null;
  const advanced = advancedAccountId === accountId;
  const currentPendingAction = pendingAction?.accountId === accountId ? pendingAction : null;
  const actionBusy = mutationBusy || currentPendingAction !== null;

  async function runAction(
    factId: string,
    kind: "delete" | "edit" | "open",
    action: () => Promise<void>
  ): Promise<void> {
    setPendingAction({ accountId, factId, kind });
    try {
      await action();
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <section
      className="border-y border-trace-subtle py-5"
      aria-labelledby={headingId}
      data-testid="memory-profile-summary"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 px-2">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-ink" id={headingId}>
            {t(locale, "title")}
          </h3>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-secondary">
            {t(locale, "description")}
          </p>
        </div>
        {ready ? <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="text-metadata text-ink-muted">
            {t(locale, "updated")} · {updatedLabel(locale, ready.createdAt)}
          </p>
          <button
            className={`${quietButton} -my-2 -mr-2`}
            type="button"
            aria-controls={advancedId}
            aria-expanded={advanced}
            onClick={() => setAdvancedAccountId(advanced ? null : accountId)}
          >
            {t(locale, "advanced")}
            <ChevronDown
              className={`size-4 transition-transform duration-150 motion-reduce:transition-none ${advanced ? "rotate-180" : ""}`}
              aria-hidden="true"
            />
          </button>
        </div> : null}
      </div>

      {loadState === "loading" || loadState === "idle" ? (
        <p className="px-2 pt-4 text-sm text-ink-muted" aria-live="polite">
          {t(locale, "loading")}
        </p>
      ) : null}

      {loadState === "error" ? (
        <div className="px-2 pt-4" aria-live="polite">
          <p className="text-sm leading-6 text-ink-secondary">{t(locale, "error")}</p>
          <button
            className={`${secondaryButton} mt-3`}
            type="button"
            onClick={() => void refreshMemoryProfile(accountId).catch(() => undefined)}
          >
            <RotateCw className="size-4" aria-hidden="true" />
            {t(locale, "retry")}
          </button>
        </div>
      ) : null}

      {loadState === "ready" && response && response.state !== "READY" ? (
        <p className="px-2 pt-4 text-sm leading-6 text-ink-secondary" aria-live="polite">
          {stateMessage(locale, response.state)}
        </p>
      ) : null}

      {ready ? (
        <div id={advancedId}>
          {advanced ? (
            <div className="mx-2 mt-4 border-l border-trace-strong pl-3">
              <p className="max-w-3xl text-metadata text-ink-muted">
                {t(locale, "advancedDescription")}
              </p>
              {ready.redactionState === "REDACTED" ? (
                <p className="mt-2 text-metadata text-caution">{t(locale, "redacted")}</p>
              ) : null}
            </div>
          ) : null}

          <ul className="mt-4 divide-y divide-trace-subtle" aria-label={t(locale, "title")}>
            {ready.contributors.map((contributor) => (
              <li className="px-2 py-4" key={contributor.factVersionId}>
                <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                  <p className="min-w-0 whitespace-pre-wrap text-sm leading-6 text-ink">
                    {contributor.displayText}
                  </p>
                  <div className="flex flex-wrap items-center gap-1 sm:-my-2 sm:justify-end">
                    <button
                      className={quietButton}
                      disabled={actionBusy}
                      type="button"
                      aria-label={`${t(locale, "edit")}: ${contributor.displayText}`}
                      onClick={() => void runAction(
                        contributor.factId,
                        "edit",
                        () => onEdit(contributor.factId)
                      ).catch(() => undefined)}
                    >
                      {t(locale, "edit")}
                    </button>
                    <button
                      className={destructiveQuietButton}
                      disabled={actionBusy}
                      type="button"
                      aria-label={`${t(locale, "delete")}: ${contributor.displayText}`}
                      onClick={() => void runAction(
                        contributor.factId,
                        "delete",
                        () => onDelete(contributor)
                      ).catch(() => undefined)}
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                      {currentPendingAction?.factId === contributor.factId && currentPendingAction.kind === "delete"
                        ? t(locale, "deleting")
                        : t(locale, "delete")}
                    </button>
                  </div>
                </div>
                {advanced ? (
                  <div className="mt-3 border-l border-trace-strong pl-3">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-metadata text-ink-muted">
                      <span>
                        {t(locale, "source")}: {contributor.sourceMode === "EXPLICIT"
                          ? t(locale, "explicit")
                          : t(locale, "automatic")}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{t(locale, "priority")}: {priorityLabel(locale, contributor.temperatureClass)}</span>
                      {contributor.pinned ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="inline-flex items-center gap-1">
                            <Pin className="size-3.5 text-proof" aria-hidden="true" />
                            {t(locale, "pinned")}
                          </span>
                        </>
                      ) : null}
                    </div>
                    <button
                      className={`${quietButton} -ml-3 mt-1`}
                      disabled={actionBusy}
                      type="button"
                      aria-label={`${t(locale, "sourceAndHistory")}: ${contributor.displayText}`}
                      onClick={() => void runAction(
                        contributor.factId,
                        "open",
                        () => onOpenDetails(contributor.factId)
                      ).catch(() => undefined)}
                    >
                      {t(locale, "sourceAndHistory")}
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          {mutationError ? (
            <p className="mx-2 mt-3 text-sm leading-6 text-critical" role="alert">
              {t(locale, "mutationError")}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
