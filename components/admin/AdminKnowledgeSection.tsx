"use client";

import {
  activateAdminKnowledgeProfile,
  adminKnowledgeErrorMessage,
  getAdminKnowledgeSettings,
  rollbackAdminKnowledgeProfile
} from "@/components/admin/adminKnowledgeApi";
import { inputClass, primaryButton, quietButton } from "@/components/admin/adminPrimitives";
import type {
  AdminKnowledgeOperationsAlert,
  AdminKnowledgeSettings
} from "@/lib/contracts/adminKnowledge";
import {
  Activity,
  ArrowRight,
  CircleCheck,
  RefreshCw,
  Route,
  ShieldCheck,
  TriangleAlert
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

function formatBytes(value: number): string {
  return value >= 1_000_000
    ? `${new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(value / 1_000_000)} MB`
    : `${new Intl.NumberFormat("en").format(value)} bytes`;
}

function formatDuration(value: number | null): string {
  if (value === null) return "No recent sample";
  if (value < 1_000) return `${value.toLocaleString()} ms`;
  if (value < 60_000) return `${(value / 1_000).toLocaleString("en", {
    maximumFractionDigits: 1
  })} s`;
  return `${Math.round(value / 60_000).toLocaleString()} min`;
}

const operationsAlertCopy: Record<AdminKnowledgeOperationsAlert["code"], string> = {
  knowledge_deletion_backlog: "Private-data deletion work is waiting to settle.",
  knowledge_deletion_blocked: "A private-data deletion obligation needs administrator action.",
  knowledge_ingestion_failures: "One or more Sources need processing attention.",
  knowledge_ingestion_queue_stalled: "The oldest Source has waited unusually long for processing.",
  knowledge_retrieval_degraded: "Recent Knowledge retrieval is frequently using degraded paths.",
  knowledge_upload_sessions_expired: "Expired upload sessions are awaiting cleanup or retry.",
  knowledge_v1_reconciliation_incomplete: "The legacy-to-Source reconciliation is incomplete."
};

export function AdminKnowledgeSection({
  active,
  onMutationCommitted
}: Readonly<{
  active: boolean;
  onMutationCommitted?(): void | Promise<unknown>;
}>) {
  const [settings, setSettings] = useState<AdminKnowledgeSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectedDestinationId, setSelectedDestinationId] = useState("");
  const [selectedRevisionId, setSelectedRevisionId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const autoLoadAttemptedRef = useRef(false);

  const apply = useCallback((next: AdminKnowledgeSettings) => {
    setSettings(next);
    const activeDeploymentId = next.profile.activeRevision?.destination.deploymentId ?? "";
    setSelectedDestinationId(
      next.profile.availableDestinations.some(({ deploymentId }) => deploymentId === activeDeploymentId)
        ? activeDeploymentId
        : next.profile.availableDestinations[0]?.deploymentId ?? ""
    );
    setSelectedRevisionId(
      next.profile.recentRevisions.find((revision) =>
        revision.executionAuthority === "installation" &&
        revision.id !== next.profile.activeRevision?.id)?.id ?? ""
    );
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await getAdminKnowledgeSettings();
    setLoading(false);
    if (result.ok) {
      apply(result.data);
      return;
    }
    setError(adminKnowledgeErrorMessage(result.error));
  }, [apply]);

  useEffect(() => {
    if (!active) {
      autoLoadAttemptedRef.current = false;
      return;
    }
    if (settings || loading || autoLoadAttemptedRef.current) return;
    autoLoadAttemptedRef.current = true;
    void refresh();
  }, [active, loading, refresh, settings]);

  const activateProfile = async () => {
    if (!settings || !selectedDestinationId || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await activateAdminKnowledgeProfile({
      deploymentId: selectedDestinationId,
      expectedVersion: settings.profile.version
    });
    setBusy(false);
    if (!result.ok) {
      setError(adminKnowledgeErrorMessage(result.error));
      return;
    }
    apply(result.data);
    setNotice("Knowledge profile activated. Existing Bases are rebuilding safely in the background.");
    void Promise.resolve(onMutationCommitted?.()).catch(() => undefined);
  };

  const rollbackProfile = async () => {
    if (!settings || !selectedRevisionId || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await rollbackAdminKnowledgeProfile({
      expectedVersion: settings.profile.version,
      revisionId: selectedRevisionId
    });
    setBusy(false);
    if (!result.ok) {
      setError(adminKnowledgeErrorMessage(result.error));
      return;
    }
    apply(result.data);
    setNotice("Earlier Knowledge profile selected. Existing Bases are rolling back safely in the background.");
    void Promise.resolve(onMutationCommitted?.()).catch(() => undefined);
  };

  const activeProfile = settings?.profile.activeRevision ?? null;
  const rollbackRevisions = settings?.profile.recentRevisions.filter((revision) =>
    revision.executionAuthority === "installation" && revision.id !== activeProfile?.id) ?? [];
  const healthLabel = settings?.profile.health.state === "ready"
    ? "Ready"
    : settings?.profile.health.state === "ready_with_warnings"
      ? "Legacy compatibility"
      : settings?.profile.health.state === "unavailable"
        ? "Unavailable"
        : "Not configured";
  const activationChangesProfile = Boolean(settings && selectedDestinationId && (
    selectedDestinationId !== activeProfile?.destination.deploymentId ||
    settings.profile.health.state !== "ready"
  ));
  const profileRollout = settings?.profile.migration ?? null;
  const profileRolloutPercent = profileRollout && profileRollout.totalBases > 0
    ? Math.round(profileRollout.activeProfileBases / profileRollout.totalBases * 100)
    : 100;

  return (
    <section aria-labelledby="admin-knowledge-heading" className="min-w-0 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
      <div className="max-w-5xl">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-trace-subtle pb-4">
          <div>
            <p className="text-metadata font-semibold uppercase tracking-[0.1em] text-ink-muted">Installation settings</p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight text-ink" id="admin-knowledge-heading">Knowledge processing</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-ink-secondary">
              Choose the installation route for indexing and query embeddings. Retrieval limits are fixed by the application; profile changes apply only to future work.
            </p>
          </div>
          <button
            className={quietButton}
            disabled={loading || busy}
            onClick={() => void refresh()}
            type="button"
          >
            <RefreshCw aria-hidden="true" className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        <div className="mt-4 flex gap-3 border-l-2 border-proof/60 bg-proof/[0.04] px-3 py-3 text-xs leading-5 text-ink-secondary">
          <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-proof" />
          <p>This section never lists private bases, documents, filenames, passages, or retrieval evidence. Owners continue to manage each base in Knowledge.</p>
        </div>

        {error ? <p className="mt-4 bg-critical/10 px-3 py-2 text-xs text-critical" role="alert">{error}</p> : null}
        {notice ? <p className="mt-4 bg-positive/10 px-3 py-2 text-xs text-positive" role="status">{notice}</p> : null}

        {settings ? (
          <div className="mt-6 space-y-8">
            <section aria-labelledby="knowledge-profile-heading">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-ink" id="knowledge-profile-heading">Processing profile</h3>
                  <p className="mt-1 text-xs leading-5 text-ink-muted">One installation-owned route controls future indexing and Knowledge query embeddings.</p>
                </div>
                <div className={`inline-flex items-center gap-1.5 text-xs font-medium ${settings.profile.health.state === "ready" ? "text-positive" : "text-caution"}`} role="status">
                  {settings.profile.health.state === "ready"
                    ? <CircleCheck aria-hidden="true" className="size-4" />
                    : <TriangleAlert aria-hidden="true" className="size-4" />}
                  {healthLabel}
                </div>
              </div>

              <div className="mt-4 border-y border-trace-subtle bg-workspace-rail/25 px-3 py-3" data-testid="knowledge-profile-route">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-xs text-ink-secondary">
                  <span className="inline-flex items-center gap-1.5 font-medium text-ink"><Route aria-hidden="true" className="size-4 text-proof" />Documents</span>
                  <ArrowRight aria-hidden="true" className="size-3.5 text-ink-muted" />
                  <span>Parser &amp; OCR</span>
                  <ArrowRight aria-hidden="true" className="size-3.5 text-ink-muted" />
                  <span className="font-medium text-ink">
                    {activeProfile
                      ? `${activeProfile.destination.connectionDisplayName} / ${activeProfile.destination.modelDisplayName}`
                      : "No embedding destination"}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-5 text-ink-muted">
                  The destination receives bounded normalized document text during indexing and search queries during retrieval. Activating a profile is the installation data-processing decision; the active profile, not an ordinary request, controls this destination.
                </p>
              </div>

              {settings.profile.health.code === "knowledge_profile_legacy_authority" ? (
                <p className="mt-3 border-l-2 border-caution bg-caution/[0.06] px-3 py-2 text-xs leading-5 text-ink-secondary">
                  Existing indexes are using the legacy per-user credential path. Activate a ready destination below to move future Bases and reprocessing to installation authority without changing accepted runs.
                </p>
              ) : settings.profile.health.state === "unavailable" ? (
                <p className="mt-3 border-l-2 border-critical bg-critical/[0.06] px-3 py-2 text-xs leading-5 text-ink-secondary">
                  Knowledge processing is unavailable. Repair or test the destination in Providers, then activate a ready profile. Current accepted runs remain unchanged.
                </p>
              ) : settings.profile.health.state === "not_configured" ? (
                <p className="mt-3 border-l-2 border-caution bg-caution/[0.06] px-3 py-2 text-xs leading-5 text-ink-secondary">
                  No processing route is active. Configure and test an embedding model in Providers, then activate it here before users create Knowledge Bases.
                </p>
              ) : null}

              <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
                <label className="grid gap-1.5 text-xs font-medium text-ink-secondary">
                  Embedding destination
                  <select
                    className={inputClass}
                    disabled={busy || settings.profile.availableDestinations.length === 0}
                    onChange={(event) => setSelectedDestinationId(event.currentTarget.value)}
                    value={selectedDestinationId}
                  >
                    {settings.profile.availableDestinations.length === 0
                      ? <option value="">No tested installation destination</option>
                      : settings.profile.availableDestinations.map((item) => (
                          <option key={item.deploymentId} value={item.deploymentId}>
                            {item.connectionDisplayName} / {item.modelDisplayName} · {item.targetDimension.toLocaleString()} dimensions
                          </option>
                        ))}
                  </select>
                  <span className="font-normal text-ink-muted">Only enabled embedding models with a tested installation credential appear here.</span>
                </label>
                <button
                  className={primaryButton}
                  disabled={busy || !activationChangesProfile}
                  onClick={() => void activateProfile()}
                  type="button"
                >
                  Activate for future processing
                </button>
              </div>

              {profileRollout && profileRollout.activeProfileBases < profileRollout.totalBases ? (
                <div
                  aria-label="Knowledge profile rollout"
                  className="mt-4 border-l-2 border-proof bg-proof/[0.05] px-3 py-3"
                  role="status"
                >
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="font-semibold text-ink">Profile rollout</span>
                    <span className="tabular-nums text-ink-secondary">
                      {profileRollout.activeProfileBases.toLocaleString()} / {profileRollout.totalBases.toLocaleString()} Bases ready
                    </span>
                  </div>
                  <div aria-hidden="true" className="mt-2 h-1.5 overflow-hidden rounded-full bg-trace-subtle">
                    <div
                      className="h-full rounded-full bg-proof transition-[width] duration-300 motion-reduce:transition-none"
                      style={{ width: `${profileRolloutPercent}%` }}
                    />
                  </div>
                  <p className="mt-2 text-xs leading-5 text-ink-muted">
                    {profileRollout.buildingProfileBases.toLocaleString()} rebuilding. Current snapshots stay online until each Base is complete, then switch atomically.
                  </p>
                </div>
              ) : null}

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-trace-subtle pt-4 text-xs text-ink-muted">
                <span>
                  {activeProfile ? `Active revision ${activeProfile.revisionNumber}` : "No active revision"}
                  {settings.profile.updatedBy ? ` · changed by ${settings.profile.updatedBy.displayName}` : ""}
                  {` · ${settings.profile.migration.activeProfileBases.toLocaleString()}/${settings.profile.migration.totalBases.toLocaleString()} Bases on revision`}
                </span>
                {rollbackRevisions.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="sr-only" htmlFor="knowledge-profile-rollback">Earlier processing profile</label>
                    <select
                      className={`${inputClass} min-w-52`}
                      disabled={busy}
                      id="knowledge-profile-rollback"
                      onChange={(event) => setSelectedRevisionId(event.currentTarget.value)}
                      value={selectedRevisionId}
                    >
                      {rollbackRevisions.map((revision) => (
                        <option key={revision.id} value={revision.id}>
                          Revision {revision.revisionNumber} · {revision.destination.connectionDisplayName} / {revision.destination.modelDisplayName}
                        </option>
                      ))}
                    </select>
                    <button className={quietButton} disabled={busy || !selectedRevisionId} onClick={() => void rollbackProfile()} type="button">Restore profile</button>
                  </div>
                ) : null}
              </div>
            </section>

            <section aria-labelledby="knowledge-operations-heading" className="border-t border-trace-subtle pt-7">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-ink" id="knowledge-operations-heading">Operations health</h3>
                  <p className="mt-1 text-xs leading-5 text-ink-muted">
                    Content-free queue, retrieval, migration, and deletion evidence. Checked {new Date(settings.operations.checkedAt).toLocaleString()}.
                  </p>
                </div>
                <div
                  className={`inline-flex items-center gap-1.5 text-xs font-medium ${settings.operations.alerts.length === 0 ? "text-positive" : "text-caution"}`}
                  role="status"
                >
                  {settings.operations.alerts.length === 0
                    ? <CircleCheck aria-hidden="true" className="size-4" />
                    : <Activity aria-hidden="true" className="size-4" />}
                  {settings.operations.alerts.length === 0
                    ? "No active alerts"
                    : `${settings.operations.alerts.length.toLocaleString()} active alert${settings.operations.alerts.length === 1 ? "" : "s"}`}
                </div>
              </div>

              {settings.operations.alerts.length > 0 ? (
                <ul className="mt-4 grid gap-2" aria-label="Knowledge operations alerts">
                  {settings.operations.alerts.map((alert) => (
                    <li
                      className={`border-l-2 px-3 py-2 text-xs leading-5 text-ink-secondary ${alert.severity === "critical" ? "border-critical bg-critical/[0.06]" : "border-caution bg-caution/[0.06]"}`}
                      key={alert.code}
                    >
                      {operationsAlertCopy[alert.code]}
                    </li>
                  ))}
                </ul>
              ) : null}

              <div className="mt-4 grid border-y border-trace-subtle sm:grid-cols-2 xl:grid-cols-4">
                <dl className="px-3 py-4 sm:border-r sm:border-trace-subtle">
                  <dt className="text-metadata font-semibold uppercase tracking-[0.08em] text-ink-muted">Processing</dt>
                  <dd className="mt-2 text-lg font-semibold tabular-nums text-ink">
                    {(settings.operations.ingestion.pendingArtifacts + settings.operations.ingestion.processingArtifacts).toLocaleString()}
                  </dd>
                  <dd className="mt-1 text-xs leading-5 text-ink-muted">
                    queued or active · {settings.operations.ingestion.failedArtifacts.toLocaleString()} failed · {settings.operations.ingestion.warningArtifacts.toLocaleString()} warning
                  </dd>
                  <dd className="mt-2 text-xs text-ink-secondary">
                    Ready p95 · {formatDuration(settings.operations.ingestion.p95ReadyLatencyMs24h)}
                  </dd>
                </dl>
                <dl className="border-t border-trace-subtle px-3 py-4 sm:border-r sm:border-t-0 xl:border-r">
                  <dt className="text-metadata font-semibold uppercase tracking-[0.08em] text-ink-muted">Uploads · 24h</dt>
                  <dd className="mt-2 text-lg font-semibold tabular-nums text-ink">
                    {settings.operations.ingestion.settledUploads24h.toLocaleString()}
                  </dd>
                  <dd className="mt-1 text-xs leading-5 text-ink-muted">
                    settled · {settings.operations.ingestion.items24h.toLocaleString()} admitted · {formatBytes(settings.operations.ingestion.uploadedBytes24h)} received
                  </dd>
                  <dd className="mt-2 text-xs text-ink-secondary">
                    {settings.operations.ingestion.activeUploads.toLocaleString()} active · {settings.operations.ingestion.needsAttentionUploads.toLocaleString()} need attention
                  </dd>
                </dl>
                <dl className="border-t border-trace-subtle px-3 py-4 sm:border-r xl:border-t-0">
                  <dt className="text-metadata font-semibold uppercase tracking-[0.08em] text-ink-muted">Retrieval · 24h</dt>
                  <dd className="mt-2 text-lg font-semibold tabular-nums text-ink">
                    {settings.operations.retrieval.operations24h.toLocaleString()}
                  </dd>
                  <dd className="mt-1 text-xs leading-5 text-ink-muted">
                    operations · {settings.operations.retrieval.degradedOperations24h.toLocaleString()} degraded · {settings.operations.retrieval.noAnswerOperations24h.toLocaleString()} no-answer
                  </dd>
                  <dd className="mt-2 text-xs text-ink-secondary">
                    Server p95 · {formatDuration(settings.operations.retrieval.p95DurationMs24h)}
                  </dd>
                </dl>
                <dl className="border-t border-trace-subtle px-3 py-4 xl:border-t-0">
                  <dt className="text-metadata font-semibold uppercase tracking-[0.08em] text-ink-muted">Data duties</dt>
                  <dd className="mt-2 text-lg font-semibold tabular-nums text-ink">
                    {settings.operations.deletion.pendingJobs.toLocaleString()}
                  </dd>
                  <dd className="mt-1 text-xs leading-5 text-ink-muted">
                    deletion jobs · {settings.operations.deletion.pendingObjects.toLocaleString()} object obligations
                  </dd>
                  <dd className="mt-2 text-xs text-ink-secondary">
                    V1 reconciliation · {settings.operations.migration.discrepancies === 0 ? "clean" : `${settings.operations.migration.discrepancies.toLocaleString()} discrepancies`}
                  </dd>
                </dl>
              </div>
            </section>

            <div className="grid gap-8 border-t border-trace-subtle pt-7 xl:grid-cols-[minmax(0,1.15fr)_minmax(18rem,0.85fr)]">
              <div>
                <h3 className="text-sm font-semibold text-ink">Fixed retrieval</h3>
                <p className="mt-1 text-xs leading-5 text-ink-muted">
                  Code-owned limits are applied to every focused Knowledge request and cannot be changed from Control Center.
                </p>
                <dl className="mt-4 grid border-y border-trace-subtle text-xs sm:grid-cols-2">
                  <div className="px-3 py-3 sm:border-r sm:border-trace-subtle">
                    <dt className="text-ink-muted">Hybrid candidates</dt>
                    <dd className="mt-1 text-base font-semibold tabular-nums text-ink">
                      {settings.retrieval.candidateLimit}
                    </dd>
                  </div>
                  <div className="border-t border-trace-subtle px-3 py-3 sm:border-t-0">
                    <dt className="text-ink-muted">Returned passages</dt>
                    <dd className="mt-1 text-base font-semibold tabular-nums text-ink">
                      {settings.retrieval.resultLimit}
                    </dd>
                  </div>
                </dl>
              </div>

              <aside className="border-l border-trace-subtle pl-5" aria-label="Effective Knowledge ingestion limits">
                <h3 className="text-sm font-semibold text-ink">Effective ingestion limits</h3>
                <p className="mt-1 text-xs leading-5 text-ink-muted">Read-only values from the installation environment.</p>
                <dl className="mt-4 grid gap-3 text-xs">
                  <div className="flex items-baseline justify-between gap-4 border-b border-trace-subtle pb-2"><dt className="text-ink-muted">File size</dt><dd className="font-medium text-ink">{formatBytes(settings.ingestionLimits.maxFileBytes)}</dd></div>
                  <div className="flex items-baseline justify-between gap-4 border-b border-trace-subtle pb-2"><dt className="text-ink-muted">Pages / document</dt><dd className="font-medium text-ink">{settings.ingestionLimits.maxPages.toLocaleString()}</dd></div>
                  <div className="flex items-baseline justify-between gap-4 border-b border-trace-subtle pb-2"><dt className="text-ink-muted">Normalized characters</dt><dd className="font-medium text-ink">{settings.ingestionLimits.maxNormalizedChars.toLocaleString()}</dd></div>
                  <div className="flex items-baseline justify-between gap-4"><dt className="text-ink-muted">Chunks / document</dt><dd className="font-medium text-ink">{settings.ingestionLimits.maxChunksPerDocument.toLocaleString()}</dd></div>
                </dl>
              </aside>
            </div>
          </div>
        ) : loading ? <p className="mt-5 text-sm text-ink-muted" role="status">Loading Knowledge settings…</p> : null}
      </div>
    </section>
  );
}
