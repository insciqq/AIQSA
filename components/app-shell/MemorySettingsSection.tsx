import { ManageMemories } from "@/components/app-shell/ManageMemories";
import { MemoryOperations } from "@/components/app-shell/MemoryOperations";
import { MemoryHealthPulse } from "@/components/app-shell/MemoryHealthPulse";
import { MemoryApiError } from "@/components/app-shell/memoryApi";
import {
  activateMemoryHealthAccount,
  deactivateMemoryHealthAccount,
  refreshMemoryHealth,
  useMemoryHealthStore
} from "@/components/app-shell/memoryHealthStore";
import {
  activateMemoryOperationsAccount,
  deactivateMemoryOperationsAccount,
  useMemoryOperationsStore
} from "@/components/app-shell/memoryOperationsStore";
import { memoryOperationsUiCopy } from "@/components/app-shell/memoryOperationsUiCopy";
import {
  acceptCurrentMemoryDestinations,
  refreshMemorySettings,
  updateMemoryGate,
  useMemorySettingsStore,
  type MemorySettingsMutation
} from "@/components/app-shell/memorySettingsStore";
import { memoryUiCopy } from "@/components/app-shell/memoryUiCopy";
import type { MemorySettingsResponse } from "@/lib/contracts/memory";
import type { UserMemoryHealth } from "@/lib/contracts/memoryHealth";
import { resolveMemoryCopy } from "@/lib/contracts/memoryCopy";
import {
  ArrowRight,
  Check,
  CircleAlert,
  Database,
  DatabaseZap,
  Fingerprint,
  ListChecks,
  RotateCw,
  ShieldCheck
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-overlay-surface";
const coarsePointerTarget =
  "[@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch";
const secondaryButton =
  `inline-flex min-h-touch items-center justify-center gap-2 rounded-control border border-trace-subtle bg-control-surface px-3 text-sm font-semibold text-ink-secondary hover:bg-control-hover hover:text-ink disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-60 sm:min-h-control ${coarsePointerTarget} ${focusRing}`;
const primaryButton =
  `inline-flex min-h-touch items-center justify-center gap-2 rounded-control bg-proof px-4 text-sm font-semibold text-proof-contrast hover:bg-proof-hover disabled:cursor-not-allowed disabled:bg-control-surface disabled:text-ink-disabled sm:min-h-control ${coarsePointerTarget} ${focusRing}`;

type SettingsNotice = "consent" | "error" | "saved" | "stale" | null;

function t(key: Parameters<typeof memoryUiCopy>[0]): string {
  return memoryUiCopy(key);
}

function SettingNotice({ notice }: { notice: SettingsNotice }) {
  if (!notice) return <div className="sr-only" aria-live="polite" />;
  const text = notice === "saved"
    ? t("settings.saved")
    : notice === "consent"
      ? t("settings.reviewComplete")
      : notice === "stale"
        ? t("settings.stale")
        : t("settings.saveError");
  const error = notice === "error" || notice === "stale";
  return (
    <div
      className={`mt-4 flex items-start gap-2 border-l-2 px-3 py-2 text-sm leading-5 ${error ? "border-critical bg-critical/10 text-critical" : "border-positive bg-positive/10 text-ink-secondary"}`}
      role={error ? "alert" : "status"}
    >
      {error
        ? <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        : <Check className="mt-0.5 size-4 shrink-0 text-positive" aria-hidden="true" />}
      <span>{text}</span>
    </div>
  );
}

function GateRow({
  busy,
  capability,
  description,
  label,
  name,
  onChange,
  progress,
  value
}: {
  busy: MemorySettingsMutation | null;
  capability: boolean;
  description: string;
  label: string;
  name: MemorySettingsMutation;
  onChange(next: boolean): void;
  progress?: string;
  value: boolean;
}) {
  const descriptionId = `memory-${name}-description`;
  const capabilityId = `memory-${name}-capability`;
  return (
    <div className="flex min-h-touch flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 pr-2">
        <p className="text-sm font-semibold text-ink" id={`memory-${name}-label`}>{label}</p>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-ink-muted" id={descriptionId}>{description}</p>
        <p
          className={`mt-1 text-xs font-medium ${capability ? "text-positive" : "text-caution"}`}
          id={capabilityId}
        >
          {capability ? t("settings.capabilityReady") : t("settings.capabilityUnavailable")}
        </p>
        {progress ? (
          <p className="mt-1 text-xs font-medium text-proof" role="status">
            {progress}
          </p>
        ) : null}
      </div>
      <button
        className={`inline-flex min-h-touch min-w-20 shrink-0 items-center justify-center rounded-control px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-control ${value ? "bg-control-selected text-ink" : "bg-control-surface text-ink-secondary hover:bg-control-hover hover:text-ink"} ${coarsePointerTarget} ${focusRing}`}
        type="button"
        role="switch"
        aria-checked={value}
        aria-labelledby={`memory-${name}-label`}
        aria-describedby={`${descriptionId} ${capabilityId}`}
        disabled={busy !== null}
        onClick={() => onChange(!value)}
      >
        {value ? t("common.on") : t("common.off")}
      </button>
    </div>
  );
}

function DestinationRow({
  description,
  label,
  value
}: {
  description: string;
  label: string;
  value: string | null;
}) {
  return (
    <div className="grid gap-2 py-3 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4">
      <div className="flex items-start gap-2">
        <Database className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
        <p className="text-sm font-semibold text-ink">{label}</p>
      </div>
      <div className="min-w-0">
        <p className={`break-words text-sm ${value ? "text-ink-secondary" : "text-ink-muted"}`}>
          {value ?? t("settings.destinationUnavailable")}
        </p>
        <p className="mt-1 text-xs leading-5 text-ink-muted">{description}</p>
      </div>
    </div>
  );
}

function EvidenceRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-2 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-xs font-medium text-ink-muted">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-ink-secondary">{children}</dd>
    </div>
  );
}

function formatDate(value: string | null): string {
  if (!value) return t("settings.notAccepted");
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function historyIndexingCopy(
  progress: MemorySettingsResponse["historyIndexing"]
): string | undefined {
  if (progress.state !== "INDEXING") return undefined;
  return t("settings.historyIndexing")
    .replace("{completed}", String(progress.completedChats))
    .replace("{total}", String(progress.totalChats));
}

function MemorySettings({
  data,
  health,
  healthError,
  healthLoading,
  healthOperationsEntryRef,
  onManage,
  onNotice,
  onOperations,
  onRefreshHealth,
  operationsEntryRef
}: {
  data: MemorySettingsResponse;
  health: UserMemoryHealth | null;
  healthError: boolean;
  healthLoading: boolean;
  healthOperationsEntryRef: RefObject<HTMLButtonElement | null>;
  onManage(): void;
  onNotice(notice: SettingsNotice): void;
  onOperations(source: "health" | "section"): void;
  onRefreshHealth(): void;
  operationsEntryRef: RefObject<HTMLButtonElement | null>;
}) {
  const busy = useMemorySettingsStore((state) => state.busy);
  const [reviewOpen, setReviewOpen] = useState(data.egress.reviewRequired);
  const reviewVisible = data.egress.reviewRequired || reviewOpen;

  const updateGate = (
    key: "learnAutomatically" | "referenceChatHistory" | "useMemoryFacts",
    value: boolean
  ) => {
    onNotice(null);
    void updateMemoryGate(key, value).then(
      () => {
        onNotice("saved");
        onRefreshHealth();
      },
      (error: unknown) => onNotice(
        error instanceof MemoryApiError && error.code === "memory_version_stale" ? "stale" : "error"
      )
    );
  };

  const accept = () => {
    onNotice(null);
    void acceptCurrentMemoryDestinations().then(
      () => {
        setReviewOpen(false);
        onNotice("consent");
        onRefreshHealth();
      },
      (error: unknown) => onNotice(
        error instanceof MemoryApiError && (
          error.code === "memory_version_stale" || error.code === "memory_egress_consent_required"
        ) ? "stale" : "error"
      )
    );
  };

  const capabilities = [
    [t("settings.capabilityExplicit"), data.capabilities.explicitMemory],
    [t("settings.capabilityHistory"), data.capabilities.historyRecall],
    [t("settings.capabilityLearning"), data.capabilities.automaticLearning]
  ] as const;

  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="flex items-start gap-3">
        <ListChecks className="mt-0.5 size-5 shrink-0 text-proof" aria-hidden="true" />
        <div>
          <h3 className="text-base font-semibold text-ink" id="memory-heading">{t("settings.heading")}</h3>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-secondary">{t("settings.intro")}</p>
        </div>
      </div>

      <MemoryHealthPulse
        advancedContent={(
          <>
            <section className="mt-4 border-t border-trace-subtle pt-3" aria-labelledby="memory-capabilities-heading">
              <h5 className="text-xs font-semibold text-ink" id="memory-capabilities-heading">
                {t("settings.capabilitiesHeading")}
              </h5>
              <ul className="mt-2 divide-y divide-trace-subtle">
                {capabilities.map(([label, available]) => (
                  <li className="flex min-h-control items-center justify-between gap-3 py-2" key={label}>
                    <span className="text-xs text-ink-secondary">{label}</span>
                    <span className={`text-xs font-semibold ${available ? "text-positive" : "text-ink-muted"}`}>
                      {available ? t("common.available") : t("common.unavailable")}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
            {data.egress.consentMode === "PER_USER" ? (
              <section className="mt-4 border-t border-trace-subtle pt-3" aria-labelledby="memory-egress-evidence-heading">
                <h5 className="text-xs font-semibold text-ink" id="memory-egress-evidence-heading">
                  {t("settings.destinationsHeading")}
                </h5>
                <dl className="mt-2 divide-y divide-trace-subtle">
                  <EvidenceRow label={t("settings.currentFingerprint")}>
                    <code className="break-all font-mono text-xs">{data.egress.currentUtilityEgressFingerprint}</code>
                  </EvidenceRow>
                  <EvidenceRow label={t("settings.acceptedFingerprint")}>
                    {data.egress.acceptedUtilityEgressFingerprint
                      ? <code className="break-all font-mono text-xs">{data.egress.acceptedUtilityEgressFingerprint}</code>
                      : t("settings.notAccepted")}
                  </EvidenceRow>
                  <EvidenceRow label={t("settings.policyVersion")}>
                    <code className="font-mono text-xs">{data.egress.currentUtilityPolicyVersion}</code>
                  </EvidenceRow>
                  <EvidenceRow label={t("settings.acceptedAt")}>
                    {formatDate(data.egress.acceptedAt)}
                  </EvidenceRow>
                </dl>
              </section>
            ) : null}
          </>
        )}
        error={healthError}
        health={health}
        loading={healthLoading}
        onOpenOperations={() => onOperations("health")}
        onRetry={onRefreshHealth}
        operationsButtonRef={healthOperationsEntryRef}
      />

      <section className="mt-4 border-l-2 border-proof/60 bg-proof/[0.04] px-3 py-3" aria-labelledby="memory-information-heading">
        <div className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-proof" aria-hidden="true" />
          <div>
            <h4 className="text-sm font-semibold text-ink" id="memory-information-heading">
              {t("settings.informationHeading")}
            </h4>
            <ul className="mt-2 grid gap-1.5 text-xs leading-5 text-ink-secondary">
              <li>{t("settings.informationManage")}</li>
              <li>{t("settings.informationTemporary")}</li>
              <li>{t("settings.informationDestinations")}</li>
              <li>{t("settings.informationRisk")}</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="mt-7" aria-labelledby="memory-policy-heading">
        <h4 className="text-sm font-semibold text-ink" id="memory-policy-heading">{t("settings.policyHeading")}</h4>
        <p className="mt-1 text-xs leading-5 text-ink-muted">{t("settings.policyDescription")}</p>
        <div className="mt-3 divide-y divide-trace-subtle border-y border-trace-subtle">
          <GateRow
            busy={busy}
            capability={data.capabilities.explicitMemory}
            description={t("settings.useFactsDescription")}
            label={resolveMemoryCopy("settings.useFacts.label")}
            name="useMemoryFacts"
            value={data.settings.useMemoryFacts}
            onChange={(value) => updateGate("useMemoryFacts", value)}
          />
          <GateRow
            busy={busy}
            capability={data.capabilities.historyRecall}
            description={t("settings.referenceHistoryDescription")}
            label={resolveMemoryCopy("settings.referenceHistory.label")}
            name="referenceChatHistory"
            progress={historyIndexingCopy(data.historyIndexing)}
            value={data.settings.referenceChatHistory}
            onChange={(value) => updateGate("referenceChatHistory", value)}
          />
          <GateRow
            busy={busy}
            capability={data.capabilities.automaticLearning}
            description={t("settings.learnAutomaticallyDescription")}
            label={resolveMemoryCopy("settings.learnAutomatically.label")}
            name="learnAutomatically"
            value={data.settings.learnAutomatically}
            onChange={(value) => updateGate("learnAutomatically", value)}
          />
        </div>
      </section>

      <section className="mt-7" aria-labelledby="memory-destinations-heading">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold text-ink" id="memory-destinations-heading">{t("settings.destinationsHeading")}</h4>
            <p className="mt-1 text-xs leading-5 text-ink-muted">
              {t(data.egress.consentMode === "ADMIN"
                ? "settings.destinationsAdminManaged"
                : "settings.destinationsDescription")}
            </p>
          </div>
          <Fingerprint className="size-5 shrink-0 text-ink-muted" aria-hidden="true" />
        </div>
        {data.egress.consentMode === "PER_USER" ? (
          <>
            {data.egress.reviewRequired ? (
              <div className="mt-3 flex items-start gap-2 border-l-2 border-caution bg-caution/10 px-3 py-2 text-sm leading-5 text-ink-secondary" role="status">
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-caution" aria-hidden="true" />
                {resolveMemoryCopy("consent.reviewRequired")}
              </div>
            ) : null}
            <div className="mt-3 divide-y divide-trace-subtle border-y border-trace-subtle">
              <DestinationRow
                description={resolveMemoryCopy("consent.answerDestination")}
                label={t("settings.answerDestination")}
                value={t("settings.selectedAtRun")}
              />
              <DestinationRow
                description={resolveMemoryCopy("consent.systemDestination")}
                label={t("settings.systemDestination")}
                value={data.egress.systemModelDestination}
              />
              <DestinationRow
                description={resolveMemoryCopy("consent.embeddingDestination")}
                label={t("settings.embeddingDestination")}
                value={data.egress.embeddingDestination}
              />
              <DestinationRow
                description={resolveMemoryCopy("consent.rerankerDestination")}
                label={t("settings.rerankerDestination")}
                value={data.egress.remoteRerankerDestination}
              />
            </div>
            {!data.egress.reviewRequired ? (
              <button className={`${secondaryButton} mt-3`} onClick={() => setReviewOpen((open) => !open)} type="button" aria-expanded={reviewVisible}>
                <ShieldCheck className="size-4" aria-hidden="true" />
                {reviewVisible ? t("settings.cancelReview") : t("settings.reviewAction")}
              </button>
            ) : null}
            {reviewVisible ? (
              <div className="mt-3 border-l-2 border-proof bg-proof/5 px-3 py-3" aria-labelledby="memory-consent-title">
                <h5 className="text-sm font-semibold text-ink" id="memory-consent-title">{resolveMemoryCopy("consent.title")}</h5>
                <p className="mt-1 text-xs leading-5 text-ink-secondary">{resolveMemoryCopy("consent.explanation")}</p>
                <button className={`${primaryButton} mt-3`} disabled={busy !== null} onClick={accept} type="button">
                  <Check className="size-4" aria-hidden="true" />
                  {busy === "consent" ? t("manager.saving") : t("settings.acceptAction")}
                </button>
              </div>
            ) : null}
          </>
        ) : null}
      </section>

      <section className="mt-7 border-y border-trace-subtle py-4" aria-labelledby="memory-manage-heading">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h4 className="text-sm font-semibold text-ink" id="memory-manage-heading">{resolveMemoryCopy("settings.manage.label")}</h4>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-ink-muted">{t("settings.manageDescription")}</p>
            {!data.capabilities.explicitMemory ? (
              <p className="mt-1 text-xs font-medium text-caution">{t("settings.manageUnavailable")}</p>
            ) : null}
          </div>
          <button className={secondaryButton} disabled={!data.capabilities.explicitMemory || busy !== null} onClick={onManage} type="button">
            {resolveMemoryCopy("settings.manage.label")}
            <ArrowRight className="size-4" aria-hidden="true" />
          </button>
        </div>
      </section>

      <section className="mt-4 border-y border-trace-subtle py-4" aria-labelledby="memory-operations-heading">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <DatabaseZap className="mt-0.5 size-5 shrink-0 text-proof" aria-hidden="true" />
            <div>
              <h4 className="text-sm font-semibold text-ink" id="memory-operations-heading">
                {memoryOperationsUiCopy("entry")}
              </h4>
              <p className="mt-1 max-w-2xl text-xs leading-5 text-ink-muted">
                {memoryOperationsUiCopy("entryDescription")}
              </p>
            </div>
          </div>
          <button
            className={secondaryButton}
            disabled={busy !== null}
            onClick={() => onOperations("section")}
            ref={operationsEntryRef}
            type="button"
          >
            {memoryOperationsUiCopy("entry")}
            <ArrowRight className="size-4" aria-hidden="true" />
          </button>
        </div>
      </section>

    </div>
  );
}

export function MemorySettingsSection({
  accountId,
  onBusyChange,
  onDirtyChange,
  onOpenMemorySource
}: {
  accountId: string;
  onBusyChange?(busy: boolean): void;
  onDirtyChange?(dirty: boolean): void;
  onOpenMemorySource(chatId: string): void;
}) {
  const busy = useMemorySettingsStore((state) => state.busy);
  const data = useMemorySettingsStore((state) => state.data);
  const loadState = useMemorySettingsStore((state) => state.loadState);
  const health = useMemoryHealthStore((state) => state.data);
  const healthError = useMemoryHealthStore((state) => state.error);
  const healthLoadState = useMemoryHealthStore((state) => state.loadState);
  const operationsBusy = useMemoryOperationsStore((state) => state.busy);
  const [managerBusy, setManagerBusy] = useState(false);
  const [managerDirty, setManagerDirty] = useState(false);
  const [managing, setManaging] = useState(false);
  const [operationsOpen, setOperationsOpen] = useState(false);
  const [notice, setNotice] = useState<SettingsNotice>(null);
  const memoryScrollRef = useRef<HTMLElement>(null);
  const healthOperationsEntryRef = useRef<HTMLButtonElement>(null);
  const operationsEntryRef = useRef<HTMLButtonElement>(null);
  const operationsReturnSourceRef = useRef<"health" | "section" | null>(null);
  const returnToOperationsEntryRef = useRef(false);
  const returnToOperationsScrollTopRef = useRef(0);

  useEffect(() => {
    void refreshMemorySettings().catch(() => undefined);
  }, []);
  useEffect(() => {
    void activateMemoryHealthAccount(accountId).catch(() => undefined);
    return () => deactivateMemoryHealthAccount(accountId);
  }, [accountId]);
  useEffect(() => {
    const timer = setInterval(() => {
      void refreshMemoryHealth().catch(() => undefined);
    }, 30_000);
    return () => clearInterval(timer);
  }, [accountId]);
  useEffect(() => {
    if (data?.historyIndexing.state !== "INDEXING" || busy !== null) return;
    const timer = setInterval(() => {
      void refreshMemorySettings(true).catch(() => undefined);
    }, 2_000);
    return () => clearInterval(timer);
  }, [busy, data?.historyIndexing.state]);
  useEffect(() => {
    void activateMemoryOperationsAccount(accountId);
    return () => deactivateMemoryOperationsAccount(accountId);
  }, [accountId]);
  useEffect(() => {
    onBusyChange?.(busy !== null || managerBusy || operationsBusy !== null);
    return () => onBusyChange?.(false);
  }, [busy, managerBusy, onBusyChange, operationsBusy]);
  useEffect(() => {
    onDirtyChange?.(managerDirty);
    return () => onDirtyChange?.(false);
  }, [managerDirty, onDirtyChange]);
  useEffect(() => {
    if (!operationsOpen && returnToOperationsEntryRef.current) {
      returnToOperationsEntryRef.current = false;
      if (memoryScrollRef.current) {
        memoryScrollRef.current.scrollTop = returnToOperationsScrollTopRef.current;
      }
      const target = operationsReturnSourceRef.current === "health"
        ? healthOperationsEntryRef.current
        : operationsEntryRef.current;
      target?.focus({ preventScroll: true });
      operationsReturnSourceRef.current = null;
    }
  }, [operationsOpen]);

  return (
    <section
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-6 sm:px-6"
      aria-labelledby={managing ? undefined : "memory-heading"}
      data-testid="settings-memory-scroll"
      ref={memoryScrollRef}
    >
      {operationsOpen && data ? (
        <MemoryOperations
          data={data}
          onBack={() => {
            returnToOperationsEntryRef.current = true;
            setOperationsOpen(false);
            void refreshMemoryHealth().catch(() => undefined);
          }}
        />
      ) : managing && data ? (
        <ManageMemories
          accountId={accountId}
          onBack={() => setManaging(false)}
          onBusyChange={setManagerBusy}
          onDirtyChange={setManagerDirty}
          onOpenMemorySource={onOpenMemorySource}
          useMemoryFacts={data.settings.useMemoryFacts}
        />
      ) : data ? (
        <>
          <SettingNotice notice={notice} />
          <MemorySettings
            data={data}
            health={health}
            healthError={healthError !== null}
            healthLoading={healthLoadState === "idle" || healthLoadState === "loading"}
            healthOperationsEntryRef={healthOperationsEntryRef}
            onManage={() => setManaging(true)}
            onNotice={setNotice}
            onOperations={(source) => {
              operationsReturnSourceRef.current = source;
              returnToOperationsScrollTopRef.current = memoryScrollRef.current?.scrollTop ?? 0;
              if (memoryScrollRef.current) memoryScrollRef.current.scrollTop = 0;
              setOperationsOpen(true);
            }}
            onRefreshHealth={() => void refreshMemoryHealth().catch(() => undefined)}
            operationsEntryRef={operationsEntryRef}
          />
        </>
      ) : loadState === "error" ? (
        <div className="mx-auto max-w-3xl py-10 text-center">
          <p className="text-sm text-critical" role="alert">Memory could not be loaded.</p>
          <button className={`${secondaryButton} mt-3`} type="button" onClick={() => void refreshMemorySettings(true).catch(() => undefined)}>
            <RotateCw className="size-4" aria-hidden="true" />
            Retry
          </button>
        </div>
      ) : (
        <p className="mx-auto max-w-3xl py-10 text-center text-sm text-ink-muted" role="status">
          Loading Memory…
        </p>
      )}
    </section>
  );
}
