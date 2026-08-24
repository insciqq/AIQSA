import { ManageMemories } from "@/components/app-shell/ManageMemories";
import { ConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import {
  MemoryApiError,
  resetPersonalMemory
} from "@/components/app-shell/memoryApi";
import {
  refreshMemorySettings,
  updateMemoryGate,
  useMemorySettingsStore,
  type MemorySettingsMutation
} from "@/components/app-shell/memorySettingsStore";
import { memoryUiCopy } from "@/components/app-shell/memoryUiCopy";
import type { MemoryConsumerSettingsResponse } from "@/lib/contracts/memoryConsumer";
import {
  ArrowRight,
  Check,
  CircleAlert,
  MoreHorizontal,
  RotateCw,
  ShieldCheck,
  Trash2
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-overlay-surface";
const coarsePointerTarget =
  "[@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch";
const secondaryButton =
  `inline-flex min-h-touch items-center justify-center gap-2 rounded-control border border-trace-subtle bg-control-surface px-3 text-sm font-semibold text-ink-secondary hover:bg-control-hover hover:text-ink disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-60 sm:min-h-control ${coarsePointerTarget} ${focusRing}`;
type SettingsNotice =
  | "error"
  | "resetComplete"
  | "resetError"
  | "resetStarted"
  | "saved"
  | "stale"
  | null;
type GateKey = MemorySettingsMutation;

function t(key: Parameters<typeof memoryUiCopy>[0]): string {
  return memoryUiCopy(key);
}

function SettingNotice({ notice }: { notice: SettingsNotice }) {
  if (!notice || notice === "resetComplete" || notice === "resetStarted") {
    return <div className="sr-only" aria-live="polite" />;
  }
  const text = notice === "saved"
    ? t("settings.saved")
    : notice === "stale"
      ? t("settings.stale")
      : notice === "resetError"
        ? t("settings.resetError")
        : t("settings.saveError");
  const error = notice === "error" || notice === "stale" || notice === "resetError";
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
  controlAvailable,
  description,
  featureAvailable,
  label,
  name,
  onChange,
  pausedByMaster = false,
  value
}: {
  busy: MemorySettingsMutation | null;
  controlAvailable: boolean;
  description: string;
  featureAvailable: boolean;
  label: string;
  name: GateKey;
  onChange(next: boolean): void;
  pausedByMaster?: boolean;
  value: boolean;
}) {
  const descriptionId = `memory-${name}-description`;
  const statusId = `memory-${name}-status`;
  const paused = !value || pausedByMaster;
  const status = !controlAvailable || !paused && !featureAvailable
    ? t("settings.statusUnavailable")
    : paused
      ? t("settings.statusPaused")
      : t("settings.statusOn");
  const availableAndOn = controlAvailable && featureAvailable && !paused;
  return (
    <div className="flex min-h-touch flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 pr-2">
        <p className="text-sm font-semibold text-ink" id={`memory-${name}-label`}>{label}</p>
        <p className="mt-1 max-w-2xl text-sm leading-5 text-ink-secondary" id={descriptionId}>{description}</p>
        <p
          className={`mt-1 text-xs font-medium ${availableAndOn ? "text-positive" : controlAvailable && paused ? "text-ink-muted" : "text-caution"}`}
          id={statusId}
        >
          {status}
        </p>
      </div>
      <button
        className={`inline-flex min-h-touch min-w-20 shrink-0 items-center justify-center rounded-control px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-control ${value ? "bg-control-selected text-ink" : "bg-control-surface text-ink-secondary hover:bg-control-hover hover:text-ink"} ${coarsePointerTarget} ${focusRing}`}
        type="button"
        role="switch"
        aria-checked={value}
        aria-labelledby={`memory-${name}-label`}
        aria-describedby={`${descriptionId} ${statusId}`}
        disabled={busy !== null || !controlAvailable}
        onClick={() => onChange(!value)}
      >
        {value ? t("common.on") : t("common.off")}
      </button>
    </div>
  );
}

function ResetMemory({
  busy,
  onCancel,
  onConfirm,
  open,
  restoreFocus,
  statusText
}: {
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
  open: boolean;
  restoreFocus(): HTMLElement | null;
  statusText: string | null;
}) {
  if (!open && !statusText) return null;
  return (
    <>
      {statusText ? (
        <section className="mt-5">
          <p className="mt-3 border-l-2 border-positive bg-positive/10 px-3 py-2 text-sm leading-5 text-ink-secondary" role="status">
            {statusText}
          </p>
        </section>
      ) : null}
      {open ? (
        <ConfirmationDialog
          busy={busy}
          cancelLabel={t("settings.resetCancel")}
          confirmAriaLabel={t("settings.resetConfirm")}
          confirmLabel={busy ? t("manager.saving") : t("settings.resetConfirm")}
          dialogLabel={t("settings.resetTitle")}
          onCancel={onCancel}
          onConfirm={onConfirm}
          restoreFocus={restoreFocus}
          testId="reset-memory-confirmation"
          title={t("settings.resetTitle")}
        >
          {t("settings.resetConfirmation")}
        </ConfirmationDialog>
      ) : null}
    </>
  );
}

function MemorySettings({
  busy,
  data,
  onCancelReset,
  onConfirmReset,
  onManage,
  onNotice,
  onOpenReset,
  resetBusy,
  resetOpen,
  resetStatusText
}: {
  busy: MemorySettingsMutation | null;
  data: MemoryConsumerSettingsResponse;
  onCancelReset(): void;
  onConfirmReset(): void;
  onManage(): void;
  onNotice(notice: SettingsNotice): void;
  onOpenReset(): void;
  resetBusy: boolean;
  resetOpen: boolean;
  resetStatusText: string | null;
}) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const optionsButtonRef = useRef<HTMLButtonElement | null>(null);
  const updateGate = (key: GateKey, value: boolean) => {
    onNotice(null);
    void updateMemoryGate(key, value).then(
      () => onNotice("saved"),
      (error: unknown) => onNotice(
        error instanceof MemoryApiError && error.code === "memory_changed" ? "stale" : "error"
      )
    );
  };

  const memoryReady = data.capabilities.managementAvailable;
  const memoryStatus = data.status === "NEEDS_ADMIN_SETUP"
    ? t("settings.statusNeedsSetup")
    : data.status === "PAUSED"
      ? t("settings.statusPaused")
      : data.status === "ON"
        ? t("settings.statusOn")
        : data.status === "PREPARING"
          ? t("settings.statusPreparing")
          : t("settings.statusUnavailable");

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-proof" aria-hidden="true" />
          <div>
            <h3 className="text-base font-semibold text-ink" id="memory-heading">{t("settings.heading")}</h3>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-secondary">{t("settings.intro")}</p>
            <p className={`mt-2 text-sm font-semibold ${data.status === "ON" ? "text-positive" : memoryReady ? "text-ink-muted" : "text-caution"}`} role="status">
              {memoryStatus}
            </p>
          </div>
        </div>
        <div className="relative shrink-0">
          <button
            ref={optionsButtonRef}
            aria-expanded={overflowOpen}
            aria-haspopup="menu"
            aria-label={t("settings.optionsLabel")}
            className={`inline-flex size-10 items-center justify-center rounded-control text-ink-secondary hover:bg-control-hover hover:text-ink ${focusRing}`}
            disabled={busy !== null || resetBusy || !data.capabilities.managementAvailable}
            onClick={() => setOverflowOpen((open) => !open)}
            type="button"
          >
            <MoreHorizontal aria-hidden="true" className="size-4" />
          </button>
          {overflowOpen ? (
            <div className="absolute right-0 top-11 z-10 min-w-52 border border-trace-subtle bg-overlay-surface p-1 shadow-elevated" role="menu">
              <button
                className={`flex min-h-touch w-full items-center gap-2 rounded-control px-3 text-left text-sm font-semibold text-critical hover:bg-critical/10 ${focusRing}`}
                onClick={() => {
                  setOverflowOpen(false);
                  optionsButtonRef.current?.focus();
                  onOpenReset();
                }}
                role="menuitem"
                type="button"
              >
                <Trash2 aria-hidden="true" className="size-4" />
                {t("settings.resetLabel")}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <section className="mt-6" aria-labelledby="memory-policy-heading">
        <h4 className="text-sm font-semibold text-ink" id="memory-policy-heading">{t("settings.policyHeading")}</h4>
        <div className="mt-3 divide-y divide-trace-subtle border-y border-trace-subtle">
          <GateRow
            busy={busy}
            controlAvailable={data.capabilities.managementAvailable}
            description={t("settings.memoryDescription")}
            featureAvailable={
              data.capabilities.naturalLanguageActionsAvailable &&
              data.capabilities.retrievalAvailable
            }
            label={t("settings.memoryLabel")}
            name="useMemoryFacts"
            value={data.settings.useMemoryFacts}
            onChange={(value) => updateGate("useMemoryFacts", value)}
          />
          <GateRow
            busy={busy}
            controlAvailable={data.capabilities.managementAvailable}
            description={t("settings.searchPastChatsDescription")}
            featureAvailable={
              data.capabilities.pastChatIndexingAvailable &&
              data.capabilities.retrievalAvailable
            }
            label={t("settings.searchPastChatsLabel")}
            name="referenceChatHistory"
            pausedByMaster={!data.settings.useMemoryFacts}
            value={data.settings.referenceChatHistory}
            onChange={(value) => updateGate("referenceChatHistory", value)}
          />
          <GateRow
            busy={busy}
            controlAvailable={data.capabilities.managementAvailable}
            description={t("settings.learnAutomaticallySimpleDescription")}
            featureAvailable={data.capabilities.automaticLearningAvailable}
            label={t("settings.learnAutomaticallyLabel")}
            name="learnAutomatically"
            pausedByMaster={!data.settings.useMemoryFacts}
            value={data.settings.learnAutomatically}
            onChange={(value) => updateGate("learnAutomatically", value)}
          />
          <GateRow
            busy={busy}
            controlAvailable={data.capabilities.managementAvailable}
            description={t("settings.synthesisDescription")}
            featureAvailable={data.capabilities.synthesisAvailable}
            label={t("settings.synthesisLabel")}
            name="synthesisEnabled"
            pausedByMaster={!data.settings.useMemoryFacts}
            value={data.settings.synthesisEnabled}
            onChange={(value) => updateGate("synthesisEnabled", value)}
          />
          <GateRow
            busy={busy}
            controlAvailable={data.capabilities.managementAvailable}
            description={t("settings.decayDescription")}
            featureAvailable={data.capabilities.decayAvailable}
            label={t("settings.decayLabel")}
            name="decayEnabled"
            pausedByMaster={!data.settings.useMemoryFacts}
            value={data.settings.decayEnabled}
            onChange={(value) => updateGate("decayEnabled", value)}
          />
        </div>
      </section>

      <section className="mt-6 border-l-2 border-proof/60 bg-proof/[0.04] px-3 py-3" aria-labelledby="memory-temporary-heading">
        <div className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-proof" aria-hidden="true" />
          <div>
            <h4 className="text-sm font-semibold text-ink" id="memory-temporary-heading">{t("settings.temporaryHeading")}</h4>
            <p className="mt-1 text-sm leading-5 text-ink-secondary">{t("settings.temporaryDescription")}</p>
          </div>
        </div>
      </section>

      <section className="mt-7 border-y border-trace-subtle py-4" aria-labelledby="memory-manage-heading">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h4 className="text-sm font-semibold text-ink" id="memory-manage-heading">{t("settings.manageLabel")}</h4>
            <p className="mt-1 max-w-2xl text-sm leading-5 text-ink-secondary">{t("settings.manageDescription")}</p>
            {!data.capabilities.managementAvailable ? (
              <p className="mt-1 text-xs font-medium text-caution">{t("settings.manageUnavailable")}</p>
            ) : null}
          </div>
          <button
            className={secondaryButton}
            disabled={busy !== null || !data.capabilities.managementAvailable}
            onClick={onManage}
            type="button"
          >
            {t("settings.manageLabel")}
            <ArrowRight className="size-4" aria-hidden="true" />
          </button>
        </div>
      </section>

      <ResetMemory
        busy={resetBusy}
        onCancel={onCancelReset}
        onConfirm={onConfirmReset}
        open={resetOpen}
        restoreFocus={() => optionsButtonRef.current}
        statusText={resetStatusText}
      />
    </div>
  );
}

export function MemorySettingsSection({
  accountId,
  onBusyChange,
  onDirtyChange
}: {
  accountId: string;
  onBusyChange?(busy: boolean): void;
  onDirtyChange?(dirty: boolean): void;
}) {
  const busy = useMemorySettingsStore((state) => state.busy);
  const data = useMemorySettingsStore((state) => state.data);
  const loadState = useMemorySettingsStore((state) => state.loadState);
  const [managerBusy, setManagerBusy] = useState(false);
  const [managerDirty, setManagerDirty] = useState(false);
  const [managing, setManaging] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [notice, setNotice] = useState<SettingsNotice>(null);

  useEffect(() => {
    void refreshMemorySettings().catch(() => undefined);
  }, []);

  useEffect(() => {
    onBusyChange?.(busy !== null || managerBusy || resetBusy);
    return () => onBusyChange?.(false);
  }, [busy, managerBusy, onBusyChange, resetBusy]);

  useEffect(() => {
    onDirtyChange?.(managerDirty);
    return () => onDirtyChange?.(false);
  }, [managerDirty, onDirtyChange]);

  const resetStatusText = notice === "resetStarted" || data?.resetState === "IN_PROGRESS"
    ? t("settings.resetStarted")
    : notice === "resetComplete"
      ? t("settings.resetComplete")
      : null;

  const openReset = () => {
    setNotice(null);
    setResetOpen(true);
  };
  const cancelReset = () => {
    setResetOpen(false);
  };
  const confirmReset = () => {
    setNotice(null);
    setResetBusy(true);
    void resetPersonalMemory().then(
      async (result) => {
        setResetOpen(false);
        setNotice(result.status === "COMPLETE" ? "resetComplete" : "resetStarted");
        await refreshMemorySettings(true).catch(() => undefined);
      },
      () => setNotice("resetError")
    ).finally(() => setResetBusy(false));
  };

  return (
    <section
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-6 sm:px-6"
      aria-labelledby={managing ? undefined : "memory-heading"}
      data-testid="settings-memory-scroll"
    >
      {managing && data ? (
        <ManageMemories
          accountId={accountId}
          onBack={() => setManaging(false)}
          onBusyChange={setManagerBusy}
          onDirtyChange={setManagerDirty}
          useMemoryFacts={data.settings.useMemoryFacts}
        />
      ) : data ? (
        <>
          <SettingNotice notice={notice} />
          <MemorySettings
            busy={busy}
            data={data}
            onCancelReset={cancelReset}
            onConfirmReset={confirmReset}
            onManage={() => setManaging(true)}
            onNotice={setNotice}
            onOpenReset={openReset}
            resetBusy={resetBusy}
            resetOpen={resetOpen}
            resetStatusText={resetStatusText}
          />
        </>
      ) : loadState === "error" ? (
        <div className="mx-auto max-w-3xl py-10 text-center">
          <p className="text-sm text-critical" role="alert">{t("settings.loadError")}</p>
          <button className={`${secondaryButton} mt-3`} type="button" onClick={() => void refreshMemorySettings(true).catch(() => undefined)}>
            <RotateCw className="size-4" aria-hidden="true" />
            {t("settings.retry")}
          </button>
        </div>
      ) : (
        <p className="mx-auto max-w-3xl py-10 text-center text-sm text-ink-muted" role="status">
          {t("settings.loading")}
        </p>
      )}
    </section>
  );
}
