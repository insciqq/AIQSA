"use client";

import { resetPersonalMemory } from "@/components/app-shell/memoryApi";
import {
  refreshMemorySettings,
  updateMemoryGate,
  useMemorySettingsStore,
  type MemorySettingsMutation
} from "@/components/app-shell/memorySettingsStore";
import { memoryUiCopy } from "@/components/app-shell/memoryUiCopy";
import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { SettingsGroupLabelV2, SettingsRowV2, SettingsSwitchV2 } from "./SettingsV2";

function t(key: Parameters<typeof memoryUiCopy>[0]): string {
  return memoryUiCopy(key);
}

type ResetNotice = "complete" | "error" | "started" | null;

/** Settings › Memory owns the five controls, Library route, and confirmed reset. */
export function MemorySettingsRowsV2({
  onOpenLibrary
}: Readonly<{ onOpenLibrary(): void }>) {
  const busy = useMemorySettingsStore((state) => state.busy);
  const data = useMemorySettingsStore((state) => state.data);
  const loadState = useMemorySettingsStore((state) => state.loadState);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetNotice, setResetNotice] = useState<ResetNotice>(null);
  const resetInFlight = useRef(false);
  const resetTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    void refreshMemorySettings().catch(() => undefined);
  }, []);

  if (!data) {
    return loadState === "error" ? (
      <div className="v2-settings-note" role="alert">
        <span>{t("settings.loadError")}</span>
        <UiV2Button onClick={() => void refreshMemorySettings(true).catch(() => undefined)}>
          {t("settings.retry")}
        </UiV2Button>
      </div>
    ) : (
      <p className="v2-settings-note" role="status">{t("settings.loading")}</p>
    );
  }

  const managementAvailable = data.capabilities.managementAvailable;
  const active = data.status === "ON";
  const statusLabel = data.status === "NEEDS_ADMIN_SETUP"
    ? t("library.statusNeedsSetup")
    : data.status === "PAUSED"
      ? t("library.statusPaused")
      : data.status === "ON"
        ? t("library.statusOn")
        : data.status === "PREPARING"
          ? t("library.statusPreparing")
          : t("library.statusUnavailable");
  const statusDetail = data.status === "ON"
    ? t("settings.statusOnDescription")
    : data.status === "PAUSED"
      ? t("library.pausedDescription")
      : data.status === "PREPARING"
        ? t("library.preparingDescription")
        : data.status === "NEEDS_ADMIN_SETUP"
          ? t("library.needsSetupDescription")
          : t("library.unavailableDescription");
  const gate = (key: MemorySettingsMutation, value: boolean) => {
    void updateMemoryGate(key, value).catch(() => undefined);
  };
  const rows: ReadonlyArray<Readonly<{
    available: boolean;
    description: string;
    key: MemorySettingsMutation;
    label: string;
    value: boolean;
  }>> = [
    {
      available: data.capabilities.naturalLanguageActionsAvailable && data.capabilities.retrievalAvailable,
      description: t("settings.memoryDescription"),
      key: "useMemoryFacts",
      label: t("settings.memoryLabel"),
      value: data.settings.useMemoryFacts
    },
    {
      available: data.capabilities.pastChatIndexingAvailable && data.capabilities.retrievalAvailable,
      description: t("settings.searchPastChatsDescription"),
      key: "referenceChatHistory",
      label: t("settings.searchPastChatsLabel"),
      value: data.settings.referenceChatHistory
    },
    {
      available: data.capabilities.automaticLearningAvailable,
      description: t("settings.learnAutomaticallySimpleDescription"),
      key: "learnAutomatically",
      label: t("settings.learnAutomaticallyLabel"),
      value: data.settings.learnAutomatically
    },
    {
      available: data.capabilities.synthesisAvailable,
      description: t("settings.synthesisDescription"),
      key: "synthesisEnabled",
      label: t("settings.synthesisLabel"),
      value: data.settings.synthesisEnabled
    },
    {
      available: data.capabilities.decayAvailable,
      description: t("settings.decayDescription"),
      key: "decayEnabled",
      label: t("settings.decayLabel"),
      value: data.settings.decayEnabled
    }
  ];
  const resetPending = resetNotice === "started" || data.resetState === "IN_PROGRESS";
  const resetStatus = resetPending
    ? t("settings.resetStarted")
    : resetNotice === "complete"
      ? t("settings.resetComplete")
      : resetNotice === "error"
        ? t("settings.resetError")
        : null;

  const confirmReset = () => {
    if (resetInFlight.current) return;
    resetInFlight.current = true;
    setResetBusy(true);
    setResetNotice(null);
    void resetPersonalMemory().then(
      async (result) => {
        setResetOpen(false);
        setResetNotice(result.status === "COMPLETE" ? "complete" : "started");
        await refreshMemorySettings(true).catch(() => undefined);
      },
      () => setResetNotice("error")
    ).finally(() => {
      resetInFlight.current = false;
      setResetBusy(false);
    });
  };
  const closeReset = () => {
    setResetOpen(false);
    window.requestAnimationFrame(() => resetTriggerRef.current?.focus());
  };
  const handleResetKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && !resetBusy) {
      event.preventDefault();
      event.stopPropagation();
      closeReset();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      "button:not(:disabled)"
    )];
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      event.stopPropagation();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      event.stopPropagation();
      first.focus();
    }
  };

  return (
    <>
      <div
        className="v2-settings-status-card"
        data-state={active ? "on" : "off"}
        data-testid="settings-memory-status"
      >
        <div className="v2-settings-status-card-copy">
          <span className="v2-settings-status-dot" aria-hidden="true" />
          <div>
            <strong>{statusLabel}</strong>
            <small>{statusDetail}</small>
          </div>
        </div>
      </div>
      {rows.map((row) => (
        <SettingsRowV2 description={row.description} key={row.key} title={row.label}>
          <SettingsSwitchV2
            checked={row.value}
            disabled={busy !== null || !managementAvailable || !row.available}
            label={`${row.label}: ${row.value ? "on" : "off"}`}
            onChange={(next) => gate(row.key, next)}
          />
        </SettingsRowV2>
      ))}
      <p className="v2-settings-note">
        <UiV2Icon name="chat" />
        <span>{t("settings.temporaryDescription")}</span>
      </p>
      <SettingsRowV2
        description="Read, edit or forget individual details."
        title="Saved memories"
      >
        <UiV2Button
          disabled={!managementAvailable}
          icon="chevron-right"
          onClick={onOpenLibrary}
        >
          Open in Library
        </UiV2Button>
      </SettingsRowV2>
      <SettingsGroupLabelV2 tone="danger">Danger zone</SettingsGroupLabelV2>
      <SettingsRowV2
        description="Removes every saved detail. Your chats are not deleted."
        testId="settings-memory-reset"
        title="Forget everything"
        tone="danger"
      >
        <UiV2Button
          ref={resetTriggerRef}
          busy={resetBusy}
          disabled={!managementAvailable || data.resetState === "IN_PROGRESS"}
          tone="destructive"
          onClick={() => {
            setResetNotice(null);
            setResetOpen(true);
          }}
        >
          Forget everything…
        </UiV2Button>
        {resetNotice === "error" ? <span role="alert">{resetStatus}</span> : null}
        {resetPending || resetNotice === "complete" ? (
          <span role="status">{resetStatus}</span>
        ) : null}
      </SettingsRowV2>
      {resetOpen ? (
        <section
          aria-label={t("settings.resetTitle")}
          className="v2-memory-reset-confirm"
          data-testid="reset-memory-confirmation"
          role="alertdialog"
          onKeyDown={handleResetKeyDown}
        >
          <h2>{t("settings.resetTitle")}</h2>
          <p>{t("settings.resetConfirmation")}</p>
          <div>
            <UiV2Button autoFocus disabled={resetBusy} onClick={closeReset}>
              {t("settings.resetCancel")}
            </UiV2Button>
            <UiV2Button busy={resetBusy} tone="destructive" onClick={confirmReset}>
              {t("settings.resetConfirm")}
            </UiV2Button>
          </div>
        </section>
      ) : null}
    </>
  );
}
