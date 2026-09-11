"use client";

import {
  adminMemoryErrorMessage,
  getAdminMemoryStatus,
  startAdminMemoryRebuild,
  updateAdminMemoryAdmissionTimeout
} from "@/components/admin/adminMemoryApi";
import { inputClass } from "@/components/admin/adminPrimitives";
import {
  adminMemoryCopy,
  adminMemoryIndexCopy,
  adminMemoryQueueCopy,
  adminMemoryWorkerCopy
} from "@/components/admin/retrieval/adminMemoryUiCopy";
import { AdminStatusPill } from "@/components/admin/roles/AdminStatusPill";
import { cardClass } from "@/components/admin/roles/rolesControls";
import type { AdminRoleStatus } from "@/components/admin/roles/rolesView";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import type { AdminFeedbackController } from "@/components/admin/useAdminFeedback";
import { UiV2Button } from "@/components/ui-v2";
import { ADMIN_MEMORY_ADMISSION_TIMEOUT_LIMITS, type AdminMemoryStatus } from "@/lib/contracts/adminMemory";
import { adminMemoryProcessingCopy } from "@/lib/domain/adminMemoryProcessing";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

const POLL_MS = 30_000;

function memoryState(status: AdminMemoryStatus): Readonly<{ label: string; status: AdminRoleStatus | "reindexing" }> {
  if (status.processing.issues.some((issue) => issue.severity === "bad")) return { label: "Processing blocked", status: "unavailable" };
  if (status.processing.issues.length > 0) return { label: "Processing delayed", status: "reindexing" };
  if (!status.processing.enabled) return { label: "Paused", status: "not_assigned" };
  if (status.worker.state !== "RUNNING") return { label: "Worker not running", status: "unavailable" };
  switch (status.index.readiness) {
    case "READY":
      return { label: "Working", status: "working" };
    case "REBUILDING":
      return { label: "Rebuilding", status: "reindexing" };
    case "PREPARING":
      return { label: "Preparing", status: "reindexing" };
    case "REBUILD_REQUIRED":
      return { label: "Rebuild required", status: "reindexing" };
    case "NOT_CONFIGURED":
      return { label: "Not assigned", status: "not_assigned" };
  }
}

function StatusLine({
  children,
  label,
  tone = "normal"
}: Readonly<{ children: ReactNode; label: string; tone?: "critical" | "normal" | "positive" | "warning" }>) {
  const toneClass = tone === "critical"
    ? "text-critical"
    : tone === "warning" ? "text-caution" : tone === "positive" ? "text-positive" : "text-ink-secondary";
  return (
    <div className="grid gap-1 py-2.5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-5">
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd className={`min-w-0 text-sm font-medium ${toneClass}`}>{children}</dd>
    </div>
  );
}

/**
 * Memory card (PRD 5.7): worker, queue and index status, the admission
 * timeout with `Save`, and `Rebuild` behind a confirmation. Model
 * assignments live in Defaults & roles.
 */
export function AdminMemoryHealthCard({
  reportNotice,
  requestConfirmation
}: Readonly<{
  reportNotice: AdminFeedbackController["reportNotice"];
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
}>) {
  const copy = adminMemoryCopy("EN");
  const [status, setStatus] = useState<AdminMemoryStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [timeoutDraft, setTimeoutDraft] = useState("");
  const [timeoutDirty, setTimeoutDirty] = useState(false);
  const sequenceRef = useRef(0);
  const busyRef = useRef(false);
  const [observedAt, setObservedAt] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (busyRef.current) return;
    const sequence = ++sequenceRef.current;
    setLoading(true);
    const result = await getAdminMemoryStatus();
    if (sequence !== sequenceRef.current) return;
    setLoading(false);
    if (result.ok) {
      setStatus(result.data.memory);
      setObservedAt(new Date().toISOString());
      setTimeoutDraft((current) => (timeoutDirty ? current : String(result.data.memory.admissionTimeout.seconds)));
      setError(null);
      return;
    }
    setError(adminMemoryErrorMessage(result.error));
  }, [timeoutDirty]);

  useEffect(() => {
    let disposed = false;
    queueMicrotask(() => {
      if (!disposed) void refresh();
    });
    const timer = setInterval(() => {
      if (!disposed) void refresh();
    }, POLL_MS);
    return () => {
      disposed = true;
      sequenceRef.current += 1;
      clearInterval(timer);
    };
  }, [refresh]);

  const parsedTimeout = /^[0-9]+$/u.test(timeoutDraft) ? Number(timeoutDraft) : null;
  const timeoutValid = parsedTimeout !== null && Number.isSafeInteger(parsedTimeout) &&
    parsedTimeout >= ADMIN_MEMORY_ADMISSION_TIMEOUT_LIMITS.minSeconds &&
    parsedTimeout <= ADMIN_MEMORY_ADMISSION_TIMEOUT_LIMITS.maxSeconds;

  const saveTimeout = async () => {
    if (busy || !status || !timeoutDirty || !timeoutValid || parsedTimeout === null) return;
    setBusy(true);
    busyRef.current = true;
    const sequence = ++sequenceRef.current;
    setFormError(null);
    const result = await updateAdminMemoryAdmissionTimeout(status.admissionTimeout.version, parsedTimeout);
    if (sequence !== sequenceRef.current) return;
    busyRef.current = false;
    setBusy(false);
    if (!result.ok) {
      setFormError(adminMemoryErrorMessage(result.error));
      return;
    }
    setStatus(result.data.memory);
    setObservedAt(new Date().toISOString());
    setError(null);
    setTimeoutDraft(String(result.data.memory.admissionTimeout.seconds));
    setTimeoutDirty(false);
    reportNotice(copy.timeoutNotice);
  };

  const rebuild = async () => {
    if (busy || status?.rebuild.state !== "AVAILABLE") return;
    setBusy(true);
    busyRef.current = true;
    const sequence = ++sequenceRef.current;
    setFormError(null);
    const result = await startAdminMemoryRebuild();
    if (sequence !== sequenceRef.current) return;
    busyRef.current = false;
    setBusy(false);
    if (!result.ok) {
      setFormError(adminMemoryErrorMessage(result.error));
      return;
    }
    setStatus(result.data.memory);
    setObservedAt(new Date().toISOString());
    setError(null);
    reportNotice(copy.notice);
  };

  const requestRebuild = () => {
    requestConfirmation({
      body: copy.rebuildDescription,
      confirmLabel: copy.rebuild,
      dialogLabel: copy.rebuildConfirmTitle,
      icon: "x",
      onConfirm: () => void rebuild(),
      testId: "admin-memory-rebuild-confirmation",
      title: copy.rebuildConfirmTitle,
      tone: "warning"
    });
  };

  const state = status ? error
    ? { label: "Status unknown", status: "unavailable" as const }
    : memoryState(status) : null;

  return (
    <section aria-labelledby="admin-memory-health-heading" className={cardClass} data-testid="admin-retrieval-memory">
      <div className="flex flex-wrap items-center gap-3 px-5 py-4">
        <h2 className="text-sm font-semibold text-ink" id="admin-memory-health-heading">{copy.heading}</h2>
        {state ? <AdminStatusPill label={state.label} status={state.status} testId="memory-state" /> : null}
        <p className="min-w-0 basis-full text-xs leading-5 text-ink-muted sm:basis-auto sm:flex-1">
          {status ? copy.intro : error ?? (loading ? copy.loading : copy.statusUnavailable)}
        </p>
        {error && status ? <p className="basis-full text-xs text-critical" role="alert">{error} Current health is unknown.{observedAt ? ` Last checked ${new Date(observedAt).toLocaleString()}.` : ""}</p> : null}
      </div>

      {status ? (
        <>
          <dl aria-live="polite" className="divide-y divide-trace-subtle border-t border-trace-subtle px-5">
            <StatusLine label={copy.configured}>
              {status.configuredTargets.length === 0 ? (
                <span>{copy.configuredEmpty}</span>
              ) : (
                <ul aria-label={copy.configured} className="grid gap-1">
                  {status.configuredTargets.map((target) => (
                    <li className="break-words" key={`${target.provider} ${target.model}`}>
                      {target.model} <span className="font-normal text-ink-muted">· {target.provider}</span>
                    </li>
                  ))}
                </ul>
              )}
            </StatusLine>
            <StatusLine label={copy.worker} tone={status.worker.state === "RUNNING" ? "positive" : "critical"}>
              {adminMemoryWorkerCopy("EN", status.worker.state)}
            </StatusLine>
            <StatusLine label={copy.queue} tone={status.queue.length === 0 ? "positive" : "normal"}>
              {adminMemoryQueueCopy("EN", status.queue)}
            </StatusLine>
            <StatusLine
              label={copy.index}
              tone={status.index.readiness === "READY"
                ? "positive"
                : status.index.readiness === "REBUILD_REQUIRED"
                  ? "warning"
                  : status.index.readiness === "NOT_CONFIGURED" ? "critical" : "normal"}
            >
              {adminMemoryIndexCopy("EN", status.index)}
            </StatusLine>
            <StatusLine label={copy.activeIssue} tone={status.processing.issues.length > 0 ? "warning" : "normal"}>
              {status.processing.issues.length === 0 ? copy.noError : (
                <ul className="grid gap-3">
                  {status.processing.issues.map((issue) => {
                    const issueCopy = adminMemoryProcessingCopy(issue);
                    return <li className={issue.severity === "bad" ? "text-critical" : "text-caution"} key={issue.stage}>
                      <p>{issueCopy.title}</p>
                      <p className="mt-1 text-xs font-normal">{issueCopy.detail}</p>
                      <a className="v2-focusable mt-1 inline-block text-xs underline" href={`/admin?section=${issueCopy.section}`}>{issueCopy.action}</a>
                    </li>;
                  })}
                </ul>
              )}
            </StatusLine>
          </dl>

          <div className="grid gap-3 border-t border-trace-subtle px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <div className="grid gap-1.5 text-xs font-medium text-ink-secondary">
              <label htmlFor="memory-admission-timeout-seconds">{copy.timeoutLabel}</label>
              <span className="font-normal leading-5 text-ink-muted" id="memory-admission-timeout-description">
                {copy.timeoutDescription}
              </span>
              <input
                aria-describedby="memory-admission-timeout-description"
                aria-invalid={timeoutDraft.length > 0 && !timeoutValid ? true : undefined}
                className={`${inputClass} md:w-28`}
                disabled={busy}
                id="memory-admission-timeout-seconds"
                inputMode="numeric"
                max={ADMIN_MEMORY_ADMISSION_TIMEOUT_LIMITS.maxSeconds}
                min={ADMIN_MEMORY_ADMISSION_TIMEOUT_LIMITS.minSeconds}
                onChange={(event) => {
                  setTimeoutDraft(event.currentTarget.value);
                  setTimeoutDirty(true);
                }}
                step={1}
                type="number"
                value={timeoutDraft}
              />
            </div>
            <UiV2Button
              busy={busy && timeoutDirty}
              disabled={busy || !timeoutDirty || !timeoutValid || parsedTimeout === status.admissionTimeout.seconds}
              onClick={() => void saveTimeout()}
              tone="primary"
            >
              {copy.saveTimeout}
            </UiV2Button>
            {formError ? <p className="text-xs text-critical md:col-span-2" role="alert">{formError}</p> : null}
          </div>

          {status.rebuild.state === "AVAILABLE" ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-trace-subtle px-5 py-4">
              <p className="min-w-0 flex-1 basis-[16rem] text-sm leading-5 text-ink-secondary">{copy.rebuildDescription}</p>
              <UiV2Button disabled={busy} onClick={requestRebuild} tone="destructive">{copy.rebuild}</UiV2Button>
            </div>
          ) : status.rebuild.state === "IN_PROGRESS" ? (
            <p className="border-t border-trace-subtle px-5 py-3 text-sm text-ink-secondary" role="status">{copy.rebuildInProgress}</p>
          ) : status.rebuild.state === "UNAVAILABLE" ? (
            <p className="border-t border-trace-subtle px-5 py-3 text-sm text-caution" role="status">{copy.rebuildUnavailable}</p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
