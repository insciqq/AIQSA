import { ManageMemories } from "@/components/app-shell/ManageMemories";
import { MemoryOperations } from "@/components/app-shell/MemoryOperations";
import { MemoryApiError } from "@/components/app-shell/memoryApi";
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
  updateMemoryLocale,
  useMemorySettingsStore,
  type MemorySettingsMutation
} from "@/components/app-shell/memorySettingsStore";
import { memoryUiCopy } from "@/components/app-shell/memoryUiCopy";
import type { MemorySettingsResponse, MemoryUiLocale } from "@/lib/contracts/memory";
import { resolveMemoryCopy } from "@/lib/contracts/memoryCopy";
import {
  ArrowRight,
  Check,
  CircleAlert,
  Database,
  DatabaseZap,
  Fingerprint,
  Languages,
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

function t(locale: MemoryUiLocale, key: Parameters<typeof memoryUiCopy>[1]): string {
  return memoryUiCopy(locale, key);
}

function SettingNotice({ locale, notice }: { locale: MemoryUiLocale; notice: SettingsNotice }) {
  if (!notice) return <div className="sr-only" aria-live="polite" />;
  const text = notice === "saved"
    ? t(locale, "settings.saved")
    : notice === "consent"
      ? t(locale, "settings.reviewComplete")
      : notice === "stale"
        ? t(locale, "settings.stale")
        : t(locale, "settings.saveError");
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
  locale,
  name,
  onChange,
  value
}: {
  busy: MemorySettingsMutation | null;
  capability: boolean;
  description: string;
  label: string;
  locale: MemoryUiLocale;
  name: MemorySettingsMutation;
  onChange(next: boolean): void;
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
          {capability ? t(locale, "settings.capabilityReady") : t(locale, "settings.capabilityUnavailable")}
        </p>
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
        {value ? t(locale, "common.on") : t(locale, "common.off")}
      </button>
    </div>
  );
}

function DestinationRow({
  description,
  label,
  locale,
  value
}: {
  description: string;
  label: string;
  locale: MemoryUiLocale;
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
          {value ?? t(locale, "settings.destinationUnavailable")}
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

function formatDate(locale: MemoryUiLocale, value: string | null): string {
  if (!value) return t(locale, "settings.notAccepted");
  return new Intl.DateTimeFormat(locale === "RU" ? "ru-RU" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function MemorySettings({
  data,
  locale,
  onManage,
  onNotice,
  onOperations,
  operationsEntryRef
}: {
  data: MemorySettingsResponse;
  locale: MemoryUiLocale;
  onManage(): void;
  onNotice(notice: SettingsNotice): void;
  onOperations(): void;
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
      () => onNotice("saved"),
      (error: unknown) => onNotice(
        error instanceof MemoryApiError && error.code === "memory_version_stale" ? "stale" : "error"
      )
    );
  };

  const updateLocale = (next: MemoryUiLocale) => {
    if (next === locale || busy) return;
    onNotice(null);
    void updateMemoryLocale(next).then(
      () => onNotice("saved"),
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
      },
      (error: unknown) => onNotice(
        error instanceof MemoryApiError && (
          error.code === "memory_version_stale" || error.code === "memory_egress_consent_required"
        ) ? "stale" : "error"
      )
    );
  };

  const capabilities = [
    [t(locale, "settings.capabilityExplicit"), data.capabilities.explicitMemory],
    [t(locale, "settings.capabilityHistory"), data.capabilities.historyRecall],
    [t(locale, "settings.capabilityLearning"), data.capabilities.automaticLearning],
    [t(locale, "settings.capabilityRussian"), data.capabilities.russianQualified]
  ] as const;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-start gap-3">
        <ListChecks className="mt-0.5 size-5 shrink-0 text-proof" aria-hidden="true" />
        <div>
          <h3 className="text-base font-semibold text-ink" id="memory-heading">{t(locale, "settings.heading")}</h3>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-secondary">{t(locale, "settings.intro")}</p>
        </div>
      </div>

      <section className="mt-4 border-l-2 border-proof/60 bg-proof/[0.04] px-3 py-3" aria-labelledby="memory-information-heading">
        <div className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-proof" aria-hidden="true" />
          <div>
            <h4 className="text-sm font-semibold text-ink" id="memory-information-heading">
              {t(locale, "settings.informationHeading")}
            </h4>
            <ul className="mt-2 grid gap-1.5 text-xs leading-5 text-ink-secondary">
              <li>{t(locale, "settings.informationManage")}</li>
              <li>{t(locale, "settings.informationTemporary")}</li>
              <li>{t(locale, "settings.informationDestinations")}</li>
              <li>{t(locale, "settings.informationRisk")}</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="mt-6" aria-labelledby="memory-locale-heading">
        <div className="flex items-start gap-3">
          <Languages className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
          <div>
            <h4 className="text-sm font-semibold text-ink" id="memory-locale-heading">{t(locale, "settings.localeHeading")}</h4>
            <p className="mt-1 text-xs leading-5 text-ink-muted">{t(locale, "settings.localeDescription")}</p>
          </div>
        </div>
        <div className="mt-3 inline-flex rounded-control border border-trace-subtle bg-control-surface p-1" role="radiogroup" aria-label={t(locale, "settings.localeHeading")}>
          {(["RU", "EN"] as const).map((candidate) => (
            <button
              className={`min-h-control rounded-control px-4 text-sm font-semibold ${candidate === locale ? "bg-control-selected text-ink" : "text-ink-secondary hover:bg-control-hover hover:text-ink"} ${coarsePointerTarget} ${focusRing}`}
              key={candidate}
              type="button"
              role="radio"
              aria-checked={candidate === locale}
              disabled={busy !== null}
              onClick={() => updateLocale(candidate)}
            >
              {candidate === "RU" ? t(locale, "settings.localeRu") : t(locale, "settings.localeEn")}
            </button>
          ))}
        </div>
      </section>

      <section className="mt-7" aria-labelledby="memory-policy-heading">
        <h4 className="text-sm font-semibold text-ink" id="memory-policy-heading">{t(locale, "settings.policyHeading")}</h4>
        <p className="mt-1 text-xs leading-5 text-ink-muted">{t(locale, "settings.policyDescription")}</p>
        <div className="mt-3 divide-y divide-trace-subtle border-y border-trace-subtle">
          <GateRow
            busy={busy}
            capability={data.capabilities.explicitMemory}
            description={t(locale, "settings.useFactsDescription")}
            label={resolveMemoryCopy(locale, "settings.useFacts.label")}
            locale={locale}
            name="useMemoryFacts"
            value={data.settings.useMemoryFacts}
            onChange={(value) => updateGate("useMemoryFacts", value)}
          />
          <GateRow
            busy={busy}
            capability={data.capabilities.historyRecall}
            description={t(locale, "settings.referenceHistoryDescription")}
            label={resolveMemoryCopy(locale, "settings.referenceHistory.label")}
            locale={locale}
            name="referenceChatHistory"
            value={data.settings.referenceChatHistory}
            onChange={(value) => updateGate("referenceChatHistory", value)}
          />
          <GateRow
            busy={busy}
            capability={data.capabilities.automaticLearning}
            description={t(locale, "settings.learnAutomaticallyDescription")}
            label={resolveMemoryCopy(locale, "settings.learnAutomatically.label")}
            locale={locale}
            name="learnAutomatically"
            value={data.settings.learnAutomatically}
            onChange={(value) => updateGate("learnAutomatically", value)}
          />
        </div>
      </section>

      <section className="mt-7" aria-labelledby="memory-destinations-heading">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold text-ink" id="memory-destinations-heading">{t(locale, "settings.destinationsHeading")}</h4>
            <p className="mt-1 text-xs leading-5 text-ink-muted">
              {t(locale, data.egress.consentMode === "ADMIN"
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
                {resolveMemoryCopy(locale, "consent.reviewRequired")}
              </div>
            ) : null}
            <div className="mt-3 divide-y divide-trace-subtle border-y border-trace-subtle">
              <DestinationRow
                description={resolveMemoryCopy(locale, "consent.answerDestination")}
                label={t(locale, "settings.answerDestination")}
                locale={locale}
                value={t(locale, "settings.selectedAtRun")}
              />
              <DestinationRow
                description={resolveMemoryCopy(locale, "consent.systemDestination")}
                label={t(locale, "settings.systemDestination")}
                locale={locale}
                value={data.egress.systemModelDestination}
              />
              <DestinationRow
                description={resolveMemoryCopy(locale, "consent.embeddingDestination")}
                label={t(locale, "settings.embeddingDestination")}
                locale={locale}
                value={data.egress.embeddingDestination}
              />
              <DestinationRow
                description={resolveMemoryCopy(locale, "consent.rerankerDestination")}
                label={t(locale, "settings.rerankerDestination")}
                locale={locale}
                value={data.egress.remoteRerankerDestination}
              />
            </div>
            <dl className="mt-3 divide-y divide-trace-subtle">
              <EvidenceRow label={t(locale, "settings.currentFingerprint")}>
                <code className="break-all font-mono text-xs">{data.egress.currentUtilityEgressFingerprint}</code>
              </EvidenceRow>
              <EvidenceRow label={t(locale, "settings.acceptedFingerprint")}>
                {data.egress.acceptedUtilityEgressFingerprint
                  ? <code className="break-all font-mono text-xs">{data.egress.acceptedUtilityEgressFingerprint}</code>
                  : t(locale, "settings.notAccepted")}
              </EvidenceRow>
              <EvidenceRow label={t(locale, "settings.policyVersion")}>
                <code className="font-mono text-xs">{data.egress.currentUtilityPolicyVersion}</code>
              </EvidenceRow>
              <EvidenceRow label={t(locale, "settings.acceptedAt")}>{formatDate(locale, data.egress.acceptedAt)}</EvidenceRow>
            </dl>
            {!data.egress.reviewRequired ? (
              <button className={`${secondaryButton} mt-3`} onClick={() => setReviewOpen((open) => !open)} type="button" aria-expanded={reviewVisible}>
                <ShieldCheck className="size-4" aria-hidden="true" />
                {reviewVisible ? t(locale, "settings.cancelReview") : t(locale, "settings.reviewAction")}
              </button>
            ) : null}
            {reviewVisible ? (
              <div className="mt-3 border-l-2 border-proof bg-proof/5 px-3 py-3" aria-labelledby="memory-consent-title">
                <h5 className="text-sm font-semibold text-ink" id="memory-consent-title">{resolveMemoryCopy(locale, "consent.title")}</h5>
                <p className="mt-1 text-xs leading-5 text-ink-secondary">{resolveMemoryCopy(locale, "consent.explanation")}</p>
                <button className={`${primaryButton} mt-3`} disabled={busy !== null} onClick={accept} type="button">
                  <Check className="size-4" aria-hidden="true" />
                  {busy === "consent" ? t(locale, "manager.saving") : t(locale, "settings.acceptAction")}
                </button>
              </div>
            ) : null}
          </>
        ) : null}
      </section>

      <section className="mt-7 border-y border-trace-subtle py-4" aria-labelledby="memory-manage-heading">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h4 className="text-sm font-semibold text-ink" id="memory-manage-heading">{resolveMemoryCopy(locale, "settings.manage.label")}</h4>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-ink-muted">{t(locale, "settings.manageDescription")}</p>
            {!data.capabilities.explicitMemory ? (
              <p className="mt-1 text-xs font-medium text-caution">{t(locale, "settings.manageUnavailable")}</p>
            ) : null}
          </div>
          <button className={secondaryButton} disabled={!data.capabilities.explicitMemory || busy !== null} onClick={onManage} type="button">
            {resolveMemoryCopy(locale, "settings.manage.label")}
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
                {memoryOperationsUiCopy(locale, "entry")}
              </h4>
              <p className="mt-1 max-w-2xl text-xs leading-5 text-ink-muted">
                {memoryOperationsUiCopy(locale, "entryDescription")}
              </p>
            </div>
          </div>
          <button
            className={secondaryButton}
            disabled={busy !== null}
            onClick={onOperations}
            ref={operationsEntryRef}
            type="button"
          >
            {memoryOperationsUiCopy(locale, "entry")}
            <ArrowRight className="size-4" aria-hidden="true" />
          </button>
        </div>
      </section>

      <section className="mt-7" aria-labelledby="memory-capabilities-heading">
        <h4 className="text-sm font-semibold text-ink" id="memory-capabilities-heading">{t(locale, "settings.capabilitiesHeading")}</h4>
        <ul className="mt-3 divide-y divide-trace-subtle border-y border-trace-subtle">
          {capabilities.map(([label, available]) => (
            <li className="flex min-h-touch items-center justify-between gap-3 py-2" key={label}>
              <span className="text-sm text-ink-secondary">{label}</span>
              <span className={`text-xs font-semibold ${available ? "text-positive" : "text-ink-muted"}`}>
                {available ? t(locale, "common.available") : t(locale, "common.unavailable")}
              </span>
            </li>
          ))}
        </ul>
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
  const operationsBusy = useMemoryOperationsStore((state) => state.busy);
  const [managerBusy, setManagerBusy] = useState(false);
  const [managerDirty, setManagerDirty] = useState(false);
  const [managing, setManaging] = useState(false);
  const [operationsOpen, setOperationsOpen] = useState(false);
  const [notice, setNotice] = useState<SettingsNotice>(null);
  const memoryScrollRef = useRef<HTMLElement>(null);
  const operationsEntryRef = useRef<HTMLButtonElement>(null);
  const returnToOperationsEntryRef = useRef(false);
  const returnToOperationsScrollTopRef = useRef(0);

  useEffect(() => {
    void refreshMemorySettings().catch(() => undefined);
  }, []);
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
      operationsEntryRef.current?.focus({ preventScroll: true });
    }
  }, [operationsOpen]);

  const locale = data?.settings.memoryUiLocale ?? null;
  return (
    <section
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-6 sm:px-6"
      aria-labelledby={managing ? undefined : "memory-heading"}
      data-testid="settings-memory-scroll"
      ref={memoryScrollRef}
    >
      {operationsOpen && data && locale ? (
        <MemoryOperations
          data={data}
          locale={locale}
          onBack={() => {
            returnToOperationsEntryRef.current = true;
            setOperationsOpen(false);
          }}
        />
      ) : managing && data && locale ? (
        <ManageMemories
          accountId={accountId}
          locale={locale}
          onBack={() => setManaging(false)}
          onBusyChange={setManagerBusy}
          onDirtyChange={setManagerDirty}
          onOpenMemorySource={onOpenMemorySource}
          useMemoryFacts={data.settings.useMemoryFacts}
        />
      ) : data && locale ? (
        <>
          <SettingNotice locale={locale} notice={notice} />
          <MemorySettings
            data={data}
            locale={locale}
            onManage={() => setManaging(true)}
            onNotice={setNotice}
            onOperations={() => {
              returnToOperationsScrollTopRef.current = memoryScrollRef.current?.scrollTop ?? 0;
              if (memoryScrollRef.current) memoryScrollRef.current.scrollTop = 0;
              setOperationsOpen(true);
            }}
            operationsEntryRef={operationsEntryRef}
          />
        </>
      ) : loadState === "error" ? (
        <div className="mx-auto max-w-3xl py-10 text-center">
          <p className="text-sm text-critical" role="alert">Память не загрузилась / Memory could not be loaded.</p>
          <button className={`${secondaryButton} mt-3`} type="button" onClick={() => void refreshMemorySettings(true).catch(() => undefined)}>
            <RotateCw className="size-4" aria-hidden="true" />
            Повторить / Retry
          </button>
        </div>
      ) : (
        <p className="mx-auto max-w-3xl py-10 text-center text-sm text-ink-muted" role="status">
          Загрузка Памяти… / Loading Memory…
        </p>
      )}
    </section>
  );
}
