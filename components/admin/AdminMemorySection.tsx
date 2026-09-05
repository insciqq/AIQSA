"use client";

import {
  adminMemoryErrorMessage,
  getAdminMemoryStatus,
  startAdminMemoryRebuild,
  updateAdminMemoryAdmissionTimeout
} from "@/components/admin/adminMemoryApi";
import {
  inputClass,
  primaryButton,
  quietButton
} from "@/components/admin/adminPrimitives";
import {
  adminMemoryCopy,
  adminMemoryIndexCopy,
  adminMemoryQueueCopy,
  adminMemoryWorkerCopy
} from "@/components/admin/adminMemoryUiCopy";
import {
  ADMIN_MEMORY_ADMISSION_TIMEOUT_LIMITS,
  type AdminMemoryStatus
} from "@/lib/contracts/adminMemory";
import { CircleAlert, RefreshCw, RotateCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from "react";

function StatusLine({
  children,
  label,
  tone = "normal"
}: Readonly<{
  children: ReactNode;
  label: string;
  tone?: "critical" | "normal" | "positive" | "warning";
}>) {
  const toneClass = tone === "critical"
    ? "text-critical"
    : tone === "warning"
      ? "text-caution"
      : tone === "positive"
        ? "text-positive"
        : "text-ink-secondary";
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-5">
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd className={`min-w-0 text-sm font-medium ${toneClass}`}>{children}</dd>
    </div>
  );
}

function ConfiguredTargets({ targets }: Readonly<{
  targets: AdminMemoryStatus["configuredTargets"];
}>) {
  const copy = adminMemoryCopy("EN");
  if (targets.length === 0) return <span>{copy.configuredEmpty}</span>;
  return (
    <ul className="grid gap-1" aria-label={copy.configured}>
      {targets.map((target) => (
        <li className="break-words" key={`${target.provider}\u0000${target.model}`}>
          {target.model} <span className="font-normal text-ink-muted">· {target.provider}</span>
        </li>
      ))}
    </ul>
  );
}

export function AdminMemorySection({ active }: Readonly<{ active: boolean }>) {
  const [status, setStatus] = useState<AdminMemoryStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [timeoutDraft, setTimeoutDraft] = useState("");
  const [timeoutDirty, setTimeoutDirty] = useState(false);
  const autoLoadAttemptedRef = useRef(false);
  const copy = adminMemoryCopy("EN");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await getAdminMemoryStatus();
    setLoading(false);
    if (result.ok) {
      setStatus(result.data.memory);
      if (!timeoutDirty) {
        setTimeoutDraft(String(result.data.memory.admissionTimeout.seconds));
      }
      return;
    }
    setError(adminMemoryErrorMessage(result.error));
  }, [timeoutDirty]);

  useEffect(() => {
    if (!active) {
      autoLoadAttemptedRef.current = false;
      return;
    }
    if (status || loading || autoLoadAttemptedRef.current) return;
    autoLoadAttemptedRef.current = true;
    void refresh();
  }, [active, loading, refresh, status]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (!busy && !loading) void refresh();
    }, 30_000);
    return () => clearInterval(timer);
  }, [active, busy, loading, refresh]);

  const rebuild = async () => {
    if (busy || status?.rebuild.state !== "AVAILABLE") return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await startAdminMemoryRebuild();
    setBusy(false);
    if (!result.ok) {
      setError(adminMemoryErrorMessage(result.error));
      return;
    }
    setStatus(result.data.memory);
    setNotice(copy.notice);
  };

  const parsedTimeout = /^\d+$/u.test(timeoutDraft)
    ? Number(timeoutDraft)
    : null;
  const timeoutValid = parsedTimeout !== null && Number.isSafeInteger(parsedTimeout) &&
    parsedTimeout >= ADMIN_MEMORY_ADMISSION_TIMEOUT_LIMITS.minSeconds &&
    parsedTimeout <= ADMIN_MEMORY_ADMISSION_TIMEOUT_LIMITS.maxSeconds;
  const saveTimeout = async () => {
    if (busy || !status || !timeoutDirty || !timeoutValid || parsedTimeout === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await updateAdminMemoryAdmissionTimeout(
      status.admissionTimeout.version,
      parsedTimeout
    );
    setBusy(false);
    if (!result.ok) {
      setError(adminMemoryErrorMessage(result.error));
      return;
    }
    setStatus(result.data.memory);
    setTimeoutDraft(String(result.data.memory.admissionTimeout.seconds));
    setTimeoutDirty(false);
    setNotice(copy.timeoutNotice);
  };

  return (
    <section aria-labelledby="admin-memory-heading" className="min-w-0 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
      <div className="max-w-4xl">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-trace-subtle pb-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-ink" id="admin-memory-heading">{copy.heading}</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-secondary">{copy.intro}</p>
          </div>
          <button className={quietButton} disabled={loading || busy} onClick={() => void refresh()} type="button">
            <RefreshCw aria-hidden="true" className={`size-3.5 ${loading ? "animate-spin motion-reduce:animate-none" : ""}`} />
            {copy.refresh}
          </button>
        </div>

        {error ? <p className="mt-4 bg-critical/10 px-3 py-2 text-xs text-critical" role="alert">{error}</p> : null}
        {notice ? <p className="mt-4 bg-positive/10 px-3 py-2 text-xs text-positive" role="status">{notice}</p> : null}

        {status ? (
          <>
            <a className={quietButton + " mt-5"} href="/admin?section=system-models">Manage assignments in System Models</a>
            <dl className="mt-5 divide-y divide-trace-subtle border-y border-trace-subtle" aria-live="polite">
              <StatusLine label={copy.configured}>
                <ConfiguredTargets targets={status.configuredTargets} />
              </StatusLine>
              <StatusLine
                label={copy.worker}
                tone={status.worker.state === "RUNNING" ? "positive" : "critical"}
              >
                {adminMemoryWorkerCopy("EN", status.worker.state)}
              </StatusLine>
              <StatusLine
                label={copy.queue}
                tone={status.queue.length === 0 ? "positive" : "normal"}
              >
                {adminMemoryQueueCopy("EN", status.queue)}
              </StatusLine>
              <StatusLine
                label={copy.index}
                tone={status.index.readiness === "READY"
                  ? "positive"
                  : status.index.readiness === "REBUILD_REQUIRED"
                    ? "warning"
                    : status.index.readiness === "NOT_CONFIGURED"
                      ? "critical"
                      : "normal"}
              >
                {adminMemoryIndexCopy("EN", status.index)}
              </StatusLine>
              <StatusLine label={copy.activeIssue} tone={status.activeIssueCode ? "warning" : "normal"}>
                <span className={status.activeIssueCode ? "font-mono text-xs" : ""}>
                  {status.activeIssueCode ?? copy.noError}
                </span>
              </StatusLine>
            </dl>

            <div className="mt-5 border-y border-trace-subtle py-4">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-end">
                <div>
                  <label
                    className="text-xs font-medium text-ink-secondary"
                    htmlFor="memory-admission-timeout-seconds"
                  >
                    {copy.timeoutLabel}
                  </label>
                  <p className="mt-1 max-w-2xl text-xs leading-5 text-ink-muted" id="memory-admission-timeout-description">
                    {copy.timeoutDescription}
                  </p>
                </div>
                <input
                  aria-describedby="memory-admission-timeout-description"
                  aria-invalid={timeoutDraft.length > 0 && !timeoutValid}
                  className={inputClass}
                  disabled={busy || loading}
                  id="memory-admission-timeout-seconds"
                  inputMode="numeric"
                  max={ADMIN_MEMORY_ADMISSION_TIMEOUT_LIMITS.maxSeconds}
                  min={ADMIN_MEMORY_ADMISSION_TIMEOUT_LIMITS.minSeconds}
                  onChange={(event) => {
                    setTimeoutDraft(event.currentTarget.value);
                    setTimeoutDirty(true);
                    setNotice(null);
                  }}
                  step={1}
                  type="number"
                  value={timeoutDraft}
                />
                <button
                  className={primaryButton}
                  disabled={busy || !timeoutDirty || !timeoutValid ||
                    parsedTimeout === status.admissionTimeout.seconds}
                  onClick={() => void saveTimeout()}
                  type="button"
                >
                  {copy.saveTimeout}
                </button>
              </div>
            </div>

            {status.rebuild.state === "AVAILABLE" ? (
              <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-l-2 border-caution bg-caution/10 px-3 py-3">
                <div className="flex min-w-0 gap-2">
                  <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-caution" />
                  <p className="max-w-2xl text-sm leading-5 text-ink-secondary">{copy.rebuildDescription}</p>
                </div>
                <button className={`${primaryButton} min-h-touch`} disabled={busy} onClick={() => void rebuild()} type="button">
                  <RotateCw aria-hidden="true" className={`size-3.5 ${busy ? "animate-spin motion-reduce:animate-none" : ""}`} />
                  {copy.rebuild}
                </button>
              </div>
            ) : status.rebuild.state === "IN_PROGRESS" ? (
              <p className="mt-5 border-l-2 border-proof bg-proof/[0.06] px-3 py-3 text-sm text-ink-secondary" role="status">
                {copy.rebuildInProgress}
              </p>
            ) : status.rebuild.state === "UNAVAILABLE" ? (
              <p className="mt-5 border-l-2 border-caution bg-caution/10 px-3 py-3 text-sm text-ink-secondary" role="status">
                {copy.rebuildUnavailable}
              </p>
            ) : null}
          </>
        ) : loading ? <p className="mt-5 text-sm text-ink-muted" role="status">{copy.loading}</p> : null}
      </div>
    </section>
  );
}
