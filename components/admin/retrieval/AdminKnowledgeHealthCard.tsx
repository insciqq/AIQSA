"use client";

import {
  adminKnowledgeErrorMessage,
  getAdminKnowledgeSettings,
  updateAdminKnowledgeAnswerPolicy,
  updateAdminKnowledgeIngestionParallelism
} from "@/components/admin/adminKnowledgeApi";
import { inputClass } from "@/components/admin/adminPrimitives";
import { AdminStatusPill } from "@/components/admin/roles/AdminStatusPill";
import { cardClass } from "@/components/admin/roles/rolesControls";
import { knowledgeProcessingState, knowledgeProcessingSummary } from "@/components/admin/roles/rolesView";
import type { AdminFeedbackController } from "@/components/admin/useAdminFeedback";
import { UiV2Button } from "@/components/ui-v2";
import type { AdminKnowledgeOperationsAlert, AdminKnowledgeSettings } from "@/lib/contracts/adminKnowledge";
import { useCallback, useEffect, useState } from "react";

export const ADMIN_RETRIEVAL_ROLES_LINK = "Processing model and embeddings: Defaults & roles";

const alertCopy: Record<AdminKnowledgeOperationsAlert["code"], string> = {
  knowledge_deletion_backlog: "Private-data deletion work is waiting to settle.",
  knowledge_deletion_blocked: "A private-data deletion obligation needs administrator action.",
  knowledge_ingestion_failures: "One or more documents need processing attention.",
  knowledge_ingestion_queue_stalled: "The oldest document has waited unusually long for processing.",
  knowledge_retrieval_degraded: "Recent Knowledge retrieval is frequently using degraded paths.",
  knowledge_search_backend_unavailable: "The Knowledge search index is unavailable.",
  knowledge_search_projection_backlog: "Knowledge search projections are waiting to be indexed.",
  knowledge_search_projection_failures: "One or more Knowledge search projections need administrator action.",
  knowledge_search_worker_unavailable: "The Knowledge search worker heartbeat is missing or stale.",
  knowledge_upload_sessions_expired: "Expired upload sessions are awaiting cleanup or retry.",
  knowledge_v1_reconciliation_incomplete: "Legacy Knowledge reconciliation is incomplete."
};

function formatBytes(value: number): string {
  return value >= 1_000_000
    ? `${new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(value / 1_000_000)} MB`
    : `${new Intl.NumberFormat("en").format(value)} bytes`;
}

function formatDuration(value: number | null): string {
  if (value === null) return "No recent sample";
  if (value < 1_000) return `${value.toLocaleString()} ms`;
  if (value < 60_000) return `${(value / 1_000).toLocaleString("en", { maximumFractionDigits: 1 })} s`;
  return `${Math.round(value / 60_000).toLocaleString()} min`;
}

function processingNote(settings: AdminKnowledgeSettings): string | null {
  const health = settings.profile.health;
  if (health.code === "knowledge_profile_legacy_authority") {
    return "Some existing bases still process with their owners' keys. Apply a configuration in Defaults & roles to move future work to the provider's default key.";
  }
  if (health.state === "unavailable") {
    return "Knowledge processing is unavailable. Check the provider, then apply a configuration in Defaults & roles.";
  }
  if (health.state === "not_configured") {
    return "No processing configuration yet. Set documents and embeddings in Defaults & roles before people create Knowledge bases.";
  }
  return null;
}

type Draft = Readonly<{ parallelism: string; searches: string }>;

function draftFor(settings: AdminKnowledgeSettings | null): Draft {
  return {
    parallelism: settings ? String(settings.answerPolicy.ingestionParallelism) : "",
    searches: settings ? String(settings.answerPolicy.maximumKnowledgeSearches) : ""
  };
}

function boundedInteger(value: string, minimum: number, maximum: number): number | null {
  if (!/^[0-9]+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function Metric({
  detail,
  label,
  note,
  value
}: Readonly<{ detail: string; label: string; note: string; value: string }>) {
  return (
    <dl className="min-w-0 px-4 py-3">
      <dt className="text-metadata font-semibold uppercase tracking-[0.08em] text-ink-muted">{label}</dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums text-ink">{value}</dd>
      <dd className="mt-0.5 text-xs leading-5 text-ink-muted">{detail}</dd>
      <dd className="mt-1 text-xs text-ink-secondary">{note}</dd>
    </dl>
  );
}

/**
 * Knowledge card (PRD 5.7): one processing state line, alerts, the health
 * metrics, and the two future-only limits behind one `Save`. Assignments live
 * in Defaults & roles; this card only links there.
 */
export function AdminKnowledgeHealthCard({
  onMutationCommitted,
  onOpenRoles,
  reportNotice
}: Readonly<{
  onMutationCommitted?(): void | Promise<unknown>;
  onOpenRoles(): void;
  reportNotice: AdminFeedbackController["reportNotice"];
}>) {
  const [settings, setSettings] = useState<AdminKnowledgeSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [syncedSettings, setSyncedSettings] = useState(settings);
  const [draft, setDraft] = useState<Draft>(() => draftFor(settings));
  if (syncedSettings !== settings) {
    setSyncedSettings(settings);
    setDraft(draftFor(settings));
  }

  const refresh = useCallback(async () => {
    setLoading(true);
    const result = await getAdminKnowledgeSettings();
    setLoading(false);
    if (result.ok) {
      setSettings(result.data);
      setError(null);
    } else {
      setError(adminKnowledgeErrorMessage(result.error));
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    queueMicrotask(() => {
      if (!disposed) void refresh();
    });
    return () => {
      disposed = true;
    };
  }, [refresh]);

  const policy = settings?.answerPolicy ?? null;
  const searches = policy ? boundedInteger(draft.searches, policy.minimum, policy.maximum) : null;
  const parallelism = policy
    ? boundedInteger(draft.parallelism, policy.parallelismMinimum, policy.parallelismMaximum)
    : null;
  const searchesChanged = Boolean(policy) && draft.searches !== String(policy?.maximumKnowledgeSearches);
  const parallelismChanged = Boolean(policy) && draft.parallelism !== String(policy?.ingestionParallelism);
  const dirty = searchesChanged || parallelismChanged;
  const valid = (!searchesChanged || searches !== null) && (!parallelismChanged || parallelism !== null);

  const save = async () => {
    if (!settings || busy || !dirty || !valid) return;
    setBusy(true);
    setFormError(null);
    let latest = settings;
    let failure: string | null = null;
    if (searchesChanged && searches !== null) {
      const result = await updateAdminKnowledgeAnswerPolicy({
        expectedVersion: latest.answerPolicy.version,
        maximumKnowledgeSearches: searches
      });
      if (result.ok) latest = result.data;
      else failure = adminKnowledgeErrorMessage(result.error);
    }
    if (!failure && parallelismChanged && parallelism !== null) {
      const result = await updateAdminKnowledgeIngestionParallelism({
        expectedVersion: latest.answerPolicy.version,
        ingestionParallelism: parallelism
      });
      if (result.ok) latest = result.data;
      else failure = adminKnowledgeErrorMessage(result.error);
    }
    setBusy(false);
    if (latest !== settings) {
      setSettings(latest);
      void Promise.resolve(onMutationCommitted?.()).catch(() => undefined);
    }
    if (failure) {
      setFormError(failure);
      return;
    }
    reportNotice("Knowledge limits saved. New answers and future processing use them.");
  };

  const state = settings ? knowledgeProcessingState(settings.profile) : null;
  const note = settings ? processingNote(settings) : null;
  const operations = settings?.operations ?? null;
  const workerLabel = operations?.search.workerState === "healthy"
    ? "Worker healthy"
    : operations?.search.workerState === "stale" ? "Worker stale" : "Worker missing";

  return (
    <section aria-labelledby="admin-knowledge-health-heading" className={cardClass} data-testid="admin-retrieval-knowledge">
      <div className="flex flex-wrap items-center gap-3 px-5 py-4">
        <h2 className="text-sm font-semibold text-ink" id="admin-knowledge-health-heading">Knowledge</h2>
        {state ? <AdminStatusPill label={state.label} status={state.status} testId="knowledge-processing-state" /> : null}
        {settings ? (
          <p className="min-w-0 basis-full text-xs leading-5 text-ink-muted sm:basis-auto sm:flex-1" data-testid="knowledge-processing-line">
            {knowledgeProcessingSummary(settings.profile)}
          </p>
        ) : (
          <p className="text-xs text-ink-muted" role="status">{error ?? (loading ? "Loading Knowledge..." : "Knowledge is unavailable.")}</p>
        )}
        {error && settings ? <p className="basis-full text-xs text-critical" role="alert">{error}</p> : null}
        {note ? <p className="basis-full text-xs leading-5 text-caution" role="status">{note}</p> : null}
        <button
          className="v2-focusable basis-full rounded-control text-left text-sm text-proof hover:underline"
          onClick={onOpenRoles}
          type="button"
        >
          {ADMIN_RETRIEVAL_ROLES_LINK}
        </button>
      </div>

      {operations && operations.alerts.length > 0 ? (
        <ul aria-label="Knowledge alerts" className="grid gap-2 border-t border-trace-subtle px-5 py-3">
          {operations.alerts.map((alert) => (
            <li
              className={`border-l-2 pl-3 text-xs leading-5 text-ink-secondary ${alert.severity === "critical" ? "border-critical" : "border-caution"}`}
              key={alert.code}
            >
              {alertCopy[alert.code]}
            </li>
          ))}
        </ul>
      ) : null}

      {operations && settings ? (
        <>
          <div className="grid border-t border-trace-subtle sm:grid-cols-2 xl:grid-cols-5 [&>dl+dl]:border-t [&>dl+dl]:border-trace-subtle sm:[&>dl:nth-child(2)]:border-t-0 xl:[&>dl+dl]:border-l xl:[&>dl+dl]:border-t-0">
            <Metric
              detail={`queued or active · ${operations.ingestion.failedArtifacts.toLocaleString()} failed · ${operations.ingestion.warningArtifacts.toLocaleString()} warning`}
              label="Processing"
              note={`Ready p95 · ${formatDuration(operations.ingestion.p95ReadyLatencyMs24h)}`}
              value={(operations.ingestion.pendingArtifacts + operations.ingestion.processingArtifacts).toLocaleString()}
            />
            <Metric
              detail={`settled · ${operations.ingestion.items24h.toLocaleString()} admitted · ${formatBytes(operations.ingestion.uploadedBytes24h)} received`}
              label="Uploads · 24h"
              note={`${operations.ingestion.activeUploads.toLocaleString()} active · ${operations.ingestion.needsAttentionUploads.toLocaleString()} need attention`}
              value={operations.ingestion.settledUploads24h.toLocaleString()}
            />
            <Metric
              detail={`operations · ${operations.retrieval.degradedOperations24h.toLocaleString()} degraded · ${operations.retrieval.noAnswerOperations24h.toLocaleString()} no-answer`}
              label="Retrieval · 24h"
              note={`Server p95 · ${formatDuration(operations.retrieval.p95DurationMs24h)}`}
              value={operations.retrieval.operations24h.toLocaleString()}
            />
            <Metric
              detail={`ready projections · ${operations.search.pendingProjections.toLocaleString()} pending · ${operations.search.failedProjections.toLocaleString()} failed`}
              label="Search index"
              note={`Search backend ${operations.search.backendState} · ${workerLabel}`}
              value={`${operations.search.readyProjections.toLocaleString()} / ${operations.search.expectedProjections.toLocaleString()}`}
            />
            <Metric
              detail={`deletion jobs · ${operations.deletion.pendingObjects.toLocaleString()} object obligations`}
              label="Data duties"
              note={`V1 reconciliation · ${operations.migration.discrepancies === 0 ? "clean" : `${operations.migration.discrepancies.toLocaleString()} discrepancies`}`}
              value={operations.deletion.pendingJobs.toLocaleString()}
            />
          </div>

          <div className="grid gap-3 border-t border-trace-subtle px-5 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
            <div className="grid gap-1.5 text-xs font-medium text-ink-secondary">
              <label htmlFor="maximum-knowledge-searches">Maximum Knowledge searches per answer</label>
              <span className="font-normal leading-5 text-ink-muted" id="maximum-knowledge-searches-description">
                New answers only. A selection that fits {settings.answerPolicy.fullContextThresholdPercent}% of the model context is sent whole with no searches.
              </span>
              <input
                aria-describedby="maximum-knowledge-searches-description"
                aria-invalid={searchesChanged && searches === null ? true : undefined}
                className={`${inputClass} md:w-28`}
                disabled={busy}
                id="maximum-knowledge-searches"
                inputMode="numeric"
                max={settings.answerPolicy.maximum}
                min={settings.answerPolicy.minimum}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setDraft((previous) => ({ ...previous, searches: value }));
                }}
                step={1}
                type="number"
                value={draft.searches}
              />
            </div>
            <div className="grid gap-1.5 text-xs font-medium text-ink-secondary">
              <label htmlFor="knowledge-ingestion-parallelism">Parallel document processing</label>
              <span className="font-normal leading-5 text-ink-muted" id="knowledge-ingestion-parallelism-description">
                Future background processing only. Documents already processing are unaffected.
              </span>
              <input
                aria-describedby="knowledge-ingestion-parallelism-description"
                aria-invalid={parallelismChanged && parallelism === null ? true : undefined}
                className={`${inputClass} md:w-28`}
                disabled={busy}
                id="knowledge-ingestion-parallelism"
                inputMode="numeric"
                max={settings.answerPolicy.parallelismMaximum}
                min={settings.answerPolicy.parallelismMinimum}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setDraft((previous) => ({ ...previous, parallelism: value }));
                }}
                step={1}
                type="number"
                value={draft.parallelism}
              />
            </div>
            <div className="flex items-center gap-2">
              <UiV2Button busy={busy} disabled={!dirty || !valid} onClick={() => void save()} tone="primary">Save</UiV2Button>
            </div>
            {formError ? <p className="text-xs text-critical md:col-span-3" role="alert">{formError}</p> : null}
          </div>

          <p className="border-t border-trace-subtle px-5 py-3 text-xs leading-5 text-ink-muted">
            Limits from the environment: {formatBytes(settings.ingestionLimits.maxFileBytes)} per file · {settings.ingestionLimits.maxPages.toLocaleString()} pages per document · {settings.ingestionLimits.maxNormalizedChars.toLocaleString()} characters · {settings.ingestionLimits.maxChunksPerDocument.toLocaleString()} chunks per document.
          </p>
        </>
      ) : null}
    </section>
  );
}
