"use client";

import {
  acknowledgeAdminMemoryEgress,
  adminMemoryErrorMessage,
  getAdminMemoryEgress
} from "@/components/admin/adminMemoryApi";
import { primaryButton, quietButton } from "@/components/admin/adminPrimitives";
import type {
  AdminMemoryDestinationId,
  AdminMemoryDestinationRow,
  AdminMemoryEgressSettings
} from "@/lib/contracts/adminMemory";
import {
  Check,
  CircleAlert,
  Fingerprint,
  RefreshCw,
  ShieldCheck
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

const rowCopy: Record<AdminMemoryDestinationId, Readonly<{
  description: string;
  label: string;
}>> = {
  answer_provider: {
    description: "Selected snippets travel with the accepted answer request; each run pins its exact provider binding.",
    label: "Selected answer model"
  },
  embedding: {
    description: "Eligible bounded text may leave AIQSA only for the listed embedding deployments.",
    label: "Embedding deployment"
  },
  remote_reranker: {
    description: "Bounded retrieval candidates use this destination only when remote reranking is active.",
    label: "Remote reranker"
  },
  system_model: {
    description: "Extraction, consolidation, verification, profiles, and query expansion use the installation system role.",
    label: "System Memory model"
  }
};

function formatDate(value: string | null): string {
  if (!value) return "Not acknowledged";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function DestinationStatus({ row }: { row: AdminMemoryDestinationRow }) {
  const status = row.reviewRequired
    ? "Review required"
    : row.state === "BOUND_PER_RUN"
      ? "Bound per run"
      : row.state === "AVAILABLE"
        ? "Available"
        : "Not configured";
  return (
    <span className={`shrink-0 rounded-pill px-2 py-1 text-metadata font-semibold ${
      row.reviewRequired
        ? "bg-caution/10 text-caution"
        : row.state === "UNAVAILABLE"
          ? "bg-control-surface text-ink-muted"
          : "bg-positive/10 text-positive"
    }`}>
      {status}
    </span>
  );
}

function DestinationRow({ row }: { row: AdminMemoryDestinationRow }) {
  const copy = rowCopy[row.id];
  return (
    <li className="grid gap-3 py-4 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_auto] sm:items-start">
      <div>
        <p className="text-sm font-semibold text-ink">{copy.label}</p>
        <p className="mt-1 text-xs leading-5 text-ink-muted">{copy.description}</p>
      </div>
      <div className="min-w-0">
        {row.destinations.length > 0 ? (
          <ul className="grid gap-1.5 text-sm text-ink-secondary">
            {row.destinations.map((destination) => (
              <li className="break-words" key={destination}>{destination}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-muted">No current destination</p>
        )}
      </div>
      <DestinationStatus row={row} />
    </li>
  );
}

export function AdminMemorySection({ active }: Readonly<{ active: boolean }>) {
  const [settings, setSettings] = useState<AdminMemoryEgressSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const autoLoadAttemptedRef = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await getAdminMemoryEgress();
    setLoading(false);
    if (result.ok) {
      setSettings(result.data);
      return;
    }
    setError(adminMemoryErrorMessage(result.error));
  }, []);

  useEffect(() => {
    if (!active) {
      autoLoadAttemptedRef.current = false;
      return;
    }
    if (settings || loading || autoLoadAttemptedRef.current) return;
    autoLoadAttemptedRef.current = true;
    void refresh();
  }, [active, loading, refresh, settings]);

  const acknowledge = async () => {
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
      setError(adminMemoryErrorMessage(result.error));
      return;
    }
    setSettings(result.data);
    setNotice("Current Memory destinations acknowledged. Waiting work will resume automatically.");
  };

  return (
    <section aria-labelledby="admin-memory-heading" className="min-w-0 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
      <div className="max-w-6xl">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-trace-subtle pb-4">
          <div>
            <p className="text-metadata font-semibold uppercase tracking-[0.1em] text-ink-muted">Installation trust policy</p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight text-ink" id="admin-memory-heading">Memory destinations</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-ink-secondary">
              Review the external destinations eligible for Memory utility work. Exact bindings and destination receipts remain attached to every call.
            </p>
          </div>
          <button className={quietButton} disabled={loading || busy} onClick={() => void refresh()} type="button">
            <RefreshCw aria-hidden="true" className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        <div className="mt-4 flex gap-3 border-l-2 border-proof/60 bg-proof/[0.04] px-3 py-3 text-xs leading-5 text-ink-secondary">
          <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-proof" />
          <p>
            Connecting and acknowledging a destination is the installation trust decision. Memory may coexist with Search, Knowledge, and MCP tools; storage-time secret screening and the rule that Memory cannot authorize actions remain enforced.
          </p>
        </div>

        {error ? <p className="mt-4 bg-critical/10 px-3 py-2 text-xs text-critical" role="alert">{error}</p> : null}
        {notice ? <p className="mt-4 bg-positive/10 px-3 py-2 text-xs text-positive" role="status">{notice}</p> : null}

        {settings ? (
          <>
            {settings.consentMode === "PER_USER" ? (
              <div className="mt-5 flex gap-3 border-l-2 border-trace-strong bg-control-surface px-3 py-3 text-sm leading-5 text-ink-secondary">
                <Fingerprint aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-muted" />
                <p>This installation uses per-user destination review. Users retain the existing acceptance surface; no administrator action is available here.</p>
              </div>
            ) : settings.reviewRequired ? (
              <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-l-2 border-caution bg-caution/10 px-3 py-3">
                <div className="flex min-w-0 gap-2 text-sm leading-5 text-ink-secondary">
                  <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-caution" />
                  <p><span className="font-semibold text-ink">Review required.</span> New or changed destinations keep only affected external Memory work waiting.</p>
                </div>
                <button className={`${primaryButton} min-h-touch`} disabled={busy} onClick={() => void acknowledge()} type="button">
                  <Check aria-hidden="true" className="size-3.5" />
                  {busy ? "Acknowledging…" : "Acknowledge current destinations"}
                </button>
              </div>
            ) : null}

            <ul className="mt-5 divide-y divide-trace-subtle border-y border-trace-subtle" aria-label="Memory destination matrix">
              {settings.destinations.map((row) => <DestinationRow key={row.id} row={row} />)}
            </ul>

            <dl className="mt-6 grid gap-x-8 gap-y-4 border-t border-trace-subtle pt-5 text-xs sm:grid-cols-2">
              <div className="min-w-0"><dt className="text-ink-muted">Current fingerprint</dt><dd className="mt-1 break-all font-mono text-ink-secondary">{settings.currentFingerprint}</dd></div>
              <div className="min-w-0"><dt className="text-ink-muted">Acknowledged fingerprint</dt><dd className="mt-1 break-all font-mono text-ink-secondary">{settings.acceptedFingerprint ?? "Not acknowledged"}</dd></div>
              <div><dt className="text-ink-muted">Policy</dt><dd className="mt-1 font-medium text-ink-secondary">{settings.currentPolicyVersion} · {settings.consentMode}</dd></div>
              <div><dt className="text-ink-muted">Last acknowledgment</dt><dd className="mt-1 font-medium text-ink-secondary">{formatDate(settings.acceptedAt)}{settings.acceptedBy ? ` · ${settings.acceptedBy.displayName}` : ""}</dd></div>
              <div><dt className="text-ink-muted">Waiting external jobs</dt><dd className="mt-1 font-medium text-ink-secondary">{settings.waitingJobCount.toLocaleString()}</dd></div>
              <div><dt className="text-ink-muted">Policy revision</dt><dd className="mt-1 font-medium text-ink-secondary">{settings.version}</dd></div>
            </dl>
          </>
        ) : loading ? <p className="mt-5 text-sm text-ink-muted" role="status">Loading Memory destinations…</p> : null}
      </div>
    </section>
  );
}
