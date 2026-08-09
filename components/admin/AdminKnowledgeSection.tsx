"use client";

import {
  adminKnowledgeErrorMessage,
  getAdminKnowledgeSettings,
  updateAdminKnowledgePolicy
} from "@/components/admin/adminKnowledgeApi";
import { inputClass, primaryButton, quietButton } from "@/components/admin/adminPrimitives";
import { useAdminDraftProtection } from "@/components/admin/AdminDraftProtection";
import type { AdminKnowledgeSettings } from "@/lib/contracts/adminKnowledge";
import { RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type Draft = {
  candidateLimit: string;
  resultLimit: string;
  scoreThreshold: string;
};

function draftFrom(settings: AdminKnowledgeSettings): Draft {
  return {
    candidateLimit: String(settings.policy.candidateLimit),
    resultLimit: String(settings.policy.resultLimit),
    scoreThreshold: String(settings.policy.scoreThreshold)
  };
}

function formatBytes(value: number): string {
  return value >= 1_000_000
    ? `${new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(value / 1_000_000)} MB`
    : `${new Intl.NumberFormat("en").format(value)} bytes`;
}

export function AdminKnowledgeSection({
  active,
  onMutationCommitted
}: Readonly<{
  active: boolean;
  onMutationCommitted?(): void | Promise<unknown>;
}>) {
  const [settings, setSettings] = useState<AdminKnowledgeSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const autoLoadAttemptedRef = useRef(false);

  const apply = useCallback((next: AdminKnowledgeSettings) => {
    setSettings(next);
    setDraft(draftFrom(next));
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

  const values = draft ? {
    candidateLimit: Number(draft.candidateLimit),
    resultLimit: Number(draft.resultLimit),
    scoreThreshold: Number(draft.scoreThreshold)
  } : null;
  const valid = Boolean(settings && values &&
    Number.isSafeInteger(values.candidateLimit) &&
    values.candidateLimit >= settings.retrievalBounds.candidateLimit.min &&
    values.candidateLimit <= settings.retrievalBounds.candidateLimit.max &&
    Number.isSafeInteger(values.resultLimit) &&
    values.resultLimit >= settings.retrievalBounds.resultLimit.min &&
    values.resultLimit <= settings.retrievalBounds.resultLimit.max &&
    values.resultLimit <= values.candidateLimit &&
    Number.isFinite(values.scoreThreshold) &&
    values.scoreThreshold >= settings.retrievalBounds.scoreThreshold.min &&
    values.scoreThreshold <= settings.retrievalBounds.scoreThreshold.max);
  const dirty = Boolean(settings && values && (
    values.candidateLimit !== settings.policy.candidateLimit ||
    values.resultLimit !== settings.policy.resultLimit ||
    values.scoreThreshold !== settings.policy.scoreThreshold
  ));
  const requestDiscard = useAdminDraftProtection({
    dirty,
    onDiscard: () => {
      if (settings) setDraft(draftFrom(settings));
    },
    owner: "knowledge-retrieval-policy",
    pending: dirty && busy
  });

  const save = async () => {
    if (!settings || !values || !valid || !dirty || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await updateAdminKnowledgePolicy({
      ...values,
      expectedVersion: settings.policy.version
    });
    setBusy(false);
    if (!result.ok) {
      setError(adminKnowledgeErrorMessage(result.error));
      return;
    }
    apply(result.data);
    setNotice("Knowledge retrieval policy updated.");
    void Promise.resolve(onMutationCommitted?.()).catch(() => undefined);
  };

  return (
    <section aria-labelledby="admin-knowledge-heading" className="min-w-0 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
      <div className="max-w-5xl">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-trace-subtle pb-4">
          <div>
            <p className="text-metadata font-semibold uppercase tracking-[0.1em] text-ink-muted">Installation policy</p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight text-ink" id="admin-knowledge-heading">Knowledge retrieval</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-ink-secondary">
              Tune how many passages are considered and returned by future Knowledge invocations. Existing run receipts keep the exact policy they used.
            </p>
          </div>
          <button
            className={quietButton}
            disabled={loading || busy}
            onClick={() => requestDiscard(() => void refresh())}
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

        {settings && draft ? (
          <div className="mt-6 grid gap-8 xl:grid-cols-[minmax(0,1.15fr)_minmax(18rem,0.85fr)]">
            <div>
              <h3 className="text-sm font-semibold text-ink">Retrieval policy</h3>
              <p className="mt-1 text-xs leading-5 text-ink-muted">Applied at each invocation and recorded with its durable receipt.</p>
              <div className="mt-4 grid gap-4 sm:grid-cols-3">
                <label className="grid gap-1.5 text-xs font-medium text-ink-secondary">
                  Candidate passages
                  <input
                    className={inputClass}
                    disabled={busy}
                    max={settings.retrievalBounds.candidateLimit.max}
                    min={settings.retrievalBounds.candidateLimit.min}
                    onChange={(event) => setDraft({ ...draft, candidateLimit: event.currentTarget.value })}
                    type="number"
                    value={draft.candidateLimit}
                  />
                  <span className="font-normal text-ink-muted">Hybrid candidates, {settings.retrievalBounds.candidateLimit.min}–{settings.retrievalBounds.candidateLimit.max}.</span>
                </label>
                <label className="grid gap-1.5 text-xs font-medium text-ink-secondary">
                  Returned passages
                  <input
                    className={inputClass}
                    disabled={busy}
                    max={settings.retrievalBounds.resultLimit.max}
                    min={settings.retrievalBounds.resultLimit.min}
                    onChange={(event) => setDraft({ ...draft, resultLimit: event.currentTarget.value })}
                    type="number"
                    value={draft.resultLimit}
                  />
                  <span className="font-normal text-ink-muted">At most {settings.retrievalBounds.resultLimit.max}, never above candidates.</span>
                </label>
                <label className="grid gap-1.5 text-xs font-medium text-ink-secondary">
                  Score threshold
                  <input
                    className={inputClass}
                    disabled={busy}
                    max={settings.retrievalBounds.scoreThreshold.max}
                    min={settings.retrievalBounds.scoreThreshold.min}
                    onChange={(event) => setDraft({ ...draft, scoreThreshold: event.currentTarget.value })}
                    step="0.01"
                    type="number"
                    value={draft.scoreThreshold}
                  />
                  <span className="font-normal text-ink-muted">Fused score floor from 0 to 1.</span>
                </label>
              </div>
              {!valid ? <p className="mt-3 text-xs text-critical">Enter values inside the shown bounds; returned passages cannot exceed candidates.</p> : null}
              <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-trace-subtle pt-4">
                <button className={primaryButton} disabled={busy || !valid || !dirty} onClick={() => void save()} type="button">
                  Save retrieval policy
                </button>
                <span className="text-xs text-ink-muted">
                  Version {settings.policy.version}{settings.policy.updatedBy ? ` · changed by ${settings.policy.updatedBy.displayName}` : ""}
                </span>
              </div>
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
        ) : loading ? <p className="mt-5 text-sm text-ink-muted" role="status">Loading Knowledge settings…</p> : null}
      </div>
    </section>
  );
}
