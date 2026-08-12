"use client";

import {
  acknowledgeAdminMemoryEgress,
  adminMemoryErrorMessage,
  getAdminMemoryEgress
} from "@/components/admin/adminMemoryApi";
import { primaryButton, quietButton } from "@/components/admin/adminPrimitives";
import {
  adminMemoryCopy,
  adminMemoryCountCopy,
  adminMemoryDestinationCopy,
  adminMemoryDestinationStateCopy,
  adminMemoryLagCopy,
  adminMemoryOverallCopy,
  adminMemoryStateCopy,
  type AdminMemoryLocale
} from "@/components/admin/adminMemoryUiCopy";
import type {
  AdminMemoryDestinationRow,
  AdminMemoryEgressResponse
} from "@/lib/contracts/adminMemory";
import {
  Check,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Fingerprint,
  RefreshCw,
  ShieldCheck
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-overlay-surface";

function formatDate(locale: AdminMemoryLocale, value: string | null): string {
  if (!value) return adminMemoryCopy(locale).fingerprintNever;
  return new Intl.DateTimeFormat(locale === "RU" ? "ru-RU" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function DestinationStatus({
  locale,
  row
}: Readonly<{ locale: AdminMemoryLocale; row: AdminMemoryDestinationRow }>) {
  const state = row.reviewRequired
    ? "REVIEW_REQUIRED" as const
    : row.state;
  return (
    <span className={`shrink-0 rounded-pill px-2 py-1 text-metadata font-semibold ${
      row.reviewRequired
        ? "bg-caution/10 text-caution"
        : row.state === "UNAVAILABLE"
          ? "bg-control-surface text-ink-muted"
          : "bg-positive/10 text-positive"
    }`}>
      {adminMemoryDestinationStateCopy(locale, state)}
    </span>
  );
}

function DestinationRow({
  locale,
  row
}: Readonly<{ locale: AdminMemoryLocale; row: AdminMemoryDestinationRow }>) {
  const copy = adminMemoryCopy(locale);
  const rowCopy = adminMemoryDestinationCopy(locale, row.id);
  return (
    <li className="grid gap-3 py-4 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_auto] sm:items-start">
      <div>
        <p className="text-sm font-semibold text-ink">{rowCopy.label}</p>
        <p className="mt-1 text-xs leading-5 text-ink-muted">{rowCopy.description}</p>
      </div>
      <div className="min-w-0">
        {row.destinations.length > 0 ? (
          <ul className="grid gap-1.5 text-sm text-ink-secondary">
            {row.destinations.map((destination) => (
              <li className="break-words" key={destination}>{destination}</li>
            ))}
          </ul>
        ) : <p className="text-sm text-ink-muted">{copy.destinationMissing}</p>}
      </div>
      <DestinationStatus locale={locale} row={row} />
    </li>
  );
}

function StatusLine({
  label,
  state,
  tone = "normal"
}: Readonly<{
  label: string;
  state: string;
  tone?: "critical" | "normal" | "positive" | "warning";
}>) {
  const stateClass = tone === "critical"
    ? "text-critical"
    : tone === "warning"
      ? "text-caution"
      : tone === "positive"
        ? "text-positive"
        : "text-ink-secondary";
  return (
    <div className="flex min-h-control items-center justify-between gap-4 py-2.5">
      <dt className="text-sm text-ink-secondary">{label}</dt>
      <dd className={`text-right text-xs font-semibold ${stateClass}`}>{state}</dd>
    </div>
  );
}

export function AdminMemorySection({ active }: Readonly<{ active: boolean }>) {
  const [payload, setPayload] = useState<AdminMemoryEgressResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const autoLoadAttemptedRef = useRef(false);
  const locale = payload?.memoryHealth.requestLocale ?? "EN";
  const copy = adminMemoryCopy(locale);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await getAdminMemoryEgress();
    setLoading(false);
    if (result.ok) {
      setPayload(result.data);
      return;
    }
    setError(adminMemoryErrorMessage(result.error, locale));
  }, [locale]);

  useEffect(() => {
    if (!active) {
      autoLoadAttemptedRef.current = false;
      return;
    }
    if (payload || loading || autoLoadAttemptedRef.current) return;
    autoLoadAttemptedRef.current = true;
    void refresh();
  }, [active, loading, payload, refresh]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (!busy && !loading) void refresh();
    }, 30_000);
    return () => clearInterval(timer);
  }, [active, busy, loading, refresh]);

  const acknowledge = async () => {
    const settings = payload?.memoryEgress;
    if (!settings || busy || settings.consentMode !== "ADMIN") return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await acknowledgeAdminMemoryEgress({
      currentFingerprint: settings.currentFingerprint,
      expectedVersion: settings.version
    });
    setBusy(false);
    if (!result.ok) {
      setError(adminMemoryErrorMessage(result.error, locale));
      return;
    }
    setPayload(result.data);
    setNotice(adminMemoryCopy(result.data.memoryHealth.requestLocale).notice);
  };

  const health = payload?.memoryHealth ?? null;
  const settings = payload?.memoryEgress ?? null;
  const overallCopy = health ? adminMemoryOverallCopy(locale, health.overall) : null;
  const overallTone = health?.overall === "ACTION_REQUIRED" || health?.overall === "UNAVAILABLE"
    ? "border-critical"
    : health?.overall === "DEGRADED" ? "border-caution" : "border-positive";
  const OverallIcon = health?.overall === "ACTION_REQUIRED" || health?.overall === "UNAVAILABLE"
    ? CircleAlert
    : health?.overall === "DEGRADED" ? Clock3 : CheckCircle2;

  return (
    <section aria-labelledby="admin-memory-heading" className="min-w-0 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
      <div className="max-w-5xl">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-trace-subtle pb-4">
          <div>
            <p className="text-metadata font-semibold uppercase tracking-[0.1em] text-ink-muted">{copy.installationPolicy}</p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight text-ink" id="admin-memory-heading">{copy.heading}</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-ink-secondary">{copy.intro}</p>
          </div>
          <button className={quietButton} disabled={loading || busy} onClick={() => void refresh()} type="button">
            <RefreshCw aria-hidden="true" className={`size-3.5 ${loading ? "animate-spin motion-reduce:animate-none" : ""}`} />
            {copy.refresh}
          </button>
        </div>

        {error ? <p className="mt-4 bg-critical/10 px-3 py-2 text-xs text-critical" role="alert">{error}</p> : null}
        {notice ? <p className="mt-4 bg-positive/10 px-3 py-2 text-xs text-positive" role="status">{notice}</p> : null}

        {health && settings && overallCopy ? (
          <>
            <section className={`mt-5 border-l-2 ${overallTone} bg-control-surface/60 px-3 py-3`} aria-labelledby="admin-memory-overall-heading" aria-live="polite">
              <div className="flex items-start gap-3">
                <OverallIcon aria-hidden="true" className={`mt-0.5 size-4 shrink-0 ${health.overall === "ACTION_REQUIRED" || health.overall === "UNAVAILABLE" ? "text-critical" : health.overall === "DEGRADED" ? "text-caution" : "text-positive"}`} />
                <div>
                  <h3 className="text-sm font-semibold text-ink" id="admin-memory-overall-heading">{overallCopy.title}</h3>
                  <p className="mt-1 max-w-3xl text-xs leading-5 text-ink-secondary">{overallCopy.description}</p>
                </div>
              </div>
            </section>

            {health.deletion.state === "ATTENTION_REQUIRED" ? (
              <div className="mt-4 flex gap-2 border-l-2 border-critical bg-critical/10 px-3 py-3 text-sm leading-5 text-ink-secondary" role="alert">
                <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-critical" />
                <p>{copy.safetyBlocked}</p>
              </div>
            ) : null}
            {health.temporary.state === "OVERDUE" ? (
              <div className="mt-4 flex gap-2 border-l-2 border-critical bg-critical/10 px-3 py-3 text-sm leading-5 text-ink-secondary" role="alert">
                <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-critical" />
                <p>{copy.safetyTemporary}</p>
              </div>
            ) : null}

            {settings.consentMode === "PER_USER" ? (
              <div className="mt-4 flex gap-3 border-l-2 border-trace-strong bg-control-surface px-3 py-3 text-sm leading-5 text-ink-secondary">
                <Fingerprint aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-muted" />
                <p>{copy.perUser}</p>
              </div>
            ) : settings.reviewRequired ? (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-l-2 border-caution bg-caution/10 px-3 py-3">
                <div className="flex min-w-0 gap-2 text-sm leading-5 text-ink-secondary">
                  <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-caution" />
                  <p><span className="font-semibold text-ink">{copy.reviewTitle}.</span> {copy.reviewDescription}</p>
                </div>
                <button className={`${primaryButton} min-h-touch`} disabled={busy} onClick={() => void acknowledge()} type="button">
                  <Check aria-hidden="true" className="size-3.5" />
                  {busy ? copy.acknowledging : copy.acknowledge}
                </button>
              </div>
            ) : null}

            <dl className="mt-5 divide-y divide-trace-subtle border-y border-trace-subtle">
              <StatusLine
                label={copy.queue}
                state={adminMemoryStateCopy(locale, "queue", health.queue.state)}
                tone={health.queue.state === "BLOCKED" ? "critical" : health.queue.state === "DELAYED" ? "warning" : health.queue.state === "CLEAR" ? "positive" : "normal"}
              />
              <StatusLine
                label={copy.provider}
                state={adminMemoryStateCopy(locale, "provider", health.provider.state)}
                tone={health.provider.state === "DEGRADED" ? "warning" : health.provider.state === "READY" ? "positive" : "normal"}
              />
              <StatusLine
                label={copy.deletion}
                state={adminMemoryStateCopy(locale, "deletion", health.deletion.state)}
                tone={health.deletion.state === "ATTENTION_REQUIRED" ? "critical" : health.deletion.state === "CLEAR" ? "positive" : "normal"}
              />
              <StatusLine
                label={copy.scheduler}
                state={adminMemoryStateCopy(locale, "scheduler", health.scheduler.state)}
                tone={health.scheduler.state === "UNAVAILABLE" ? "critical" : health.scheduler.state === "DEFERRED" ? "warning" : "positive"}
              />
            </dl>

            <details className="mt-5 border-y border-trace-subtle py-2">
              <summary className={`min-h-touch cursor-pointer select-none py-2 text-sm font-semibold text-ink-secondary hover:text-ink ${focusRing}`}>
                {copy.advanced}
              </summary>
              <p className="pb-3 text-xs leading-5 text-ink-muted">{copy.advancedDescription}</p>

              <section className="border-t border-trace-subtle pt-4" aria-labelledby="admin-memory-evidence-heading">
                <h3 className="text-sm font-semibold text-ink" id="admin-memory-evidence-heading">{copy.operationalEvidence}</h3>
                <dl className="mt-3 grid gap-x-8 gap-y-3 text-xs sm:grid-cols-2">
                  <div><dt className="text-ink-muted">{copy.queue} · {copy.active}</dt><dd className="mt-1 font-medium text-ink-secondary">{adminMemoryCountCopy(locale, health.queue.active)}</dd></div>
                  <div><dt className="text-ink-muted">{copy.queue} · {copy.oldest}</dt><dd className="mt-1 font-medium text-ink-secondary">{adminMemoryLagCopy(locale, health.queue.oldestLag)}</dd></div>
                  <div><dt className="text-ink-muted">{copy.queue} · {copy.destinationReview}</dt><dd className="mt-1 font-medium text-ink-secondary">{adminMemoryCountCopy(locale, health.queue.waitingForReview)}</dd></div>
                  <div><dt className="text-ink-muted">{copy.queue} · {copy.recentFailures}</dt><dd className="mt-1 font-medium text-ink-secondary">{adminMemoryCountCopy(locale, health.queue.failed)}</dd></div>
                  <div><dt className="text-ink-muted">{copy.provider} · {copy.failed}</dt><dd className="mt-1 font-medium text-ink-secondary">{adminMemoryCountCopy(locale, health.provider.failedRecent)}</dd></div>
                  <div><dt className="text-ink-muted">{copy.provider} · {copy.outcomeUnknown}</dt><dd className="mt-1 font-medium text-ink-secondary">{adminMemoryCountCopy(locale, health.provider.outcomeUnknown)}</dd></div>
                  <div><dt className="text-ink-muted">{copy.provider} · {copy.usageIncomplete}</dt><dd className="mt-1 font-medium text-ink-secondary">{adminMemoryCountCopy(locale, health.provider.usageIncomplete)}</dd></div>
                  <div><dt className="text-ink-muted">{copy.deletion} · {copy.blocked}</dt><dd className="mt-1 font-medium text-ink-secondary">{adminMemoryCountCopy(locale, health.deletion.blocked)}</dd></div>
                </dl>
              </section>

              <div className="mt-5 flex gap-3 border-l-2 border-proof/60 bg-proof/[0.04] px-3 py-3 text-xs leading-5 text-ink-secondary">
                <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-proof" />
                <p>{copy.trustDescription}</p>
              </div>

              <ul className="mt-4 divide-y divide-trace-subtle border-y border-trace-subtle" aria-label={copy.destinationMatrix}>
                {settings.destinations.map((row) => <DestinationRow key={row.id} locale={locale} row={row} />)}
              </ul>

              <dl className="mt-5 grid gap-x-8 gap-y-4 border-t border-trace-subtle pt-5 text-xs sm:grid-cols-2">
                <div className="min-w-0"><dt className="text-ink-muted">{copy.currentFingerprint}</dt><dd className="mt-1 break-all font-mono text-ink-secondary">{settings.currentFingerprint}</dd></div>
                <div className="min-w-0"><dt className="text-ink-muted">{copy.acknowledgedFingerprint}</dt><dd className="mt-1 break-all font-mono text-ink-secondary">{settings.acceptedFingerprint ?? copy.fingerprintNever}</dd></div>
                <div><dt className="text-ink-muted">{copy.currentPolicy}</dt><dd className="mt-1 font-medium text-ink-secondary">{settings.currentPolicyVersion} · {settings.consentMode}</dd></div>
                <div><dt className="text-ink-muted">{copy.lastAcknowledgment}</dt><dd className="mt-1 font-medium text-ink-secondary">{formatDate(locale, settings.acceptedAt)}{settings.acceptedBy ? ` · ${settings.acceptedBy.displayName}` : ""}</dd></div>
                <div><dt className="text-ink-muted">{copy.waitingJobs}</dt><dd className="mt-1 font-medium text-ink-secondary">{settings.waitingJobCount.toLocaleString(locale === "RU" ? "ru-RU" : "en-US")}</dd></div>
                <div><dt className="text-ink-muted">{copy.policyRevision}</dt><dd className="mt-1 font-medium text-ink-secondary">{settings.version}</dd></div>
              </dl>
            </details>
          </>
        ) : loading ? <p className="mt-5 text-sm text-ink-muted" role="status">{copy.loading}</p> : null}
      </div>
    </section>
  );
}
