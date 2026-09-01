"use client";

import {
  refreshMemorySettings,
  updateMemoryGate,
  useMemorySettingsStore,
  type MemorySettingsMutation
} from "@/components/app-shell/memorySettingsStore";
import { memoryUiCopy } from "@/components/app-shell/memoryUiCopy";
import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import { useEffect } from "react";
import { SettingsRowV2, SettingsSwitchV2 } from "./SettingsV2";

function t(key: Parameters<typeof memoryUiCopy>[0]): string {
  return memoryUiCopy(key);
}

/**
 * Memory tab rows (PRD §4.9): the status card with Pause/Resume, the five
 * policy switches, the temporary-chat note and the Manage entry. The store,
 * gate mutations and copy are the existing Memory owners.
 */
export function MemorySettingsRowsV2({ onManage }: Readonly<{ onManage(): void }>) {
  const busy = useMemorySettingsStore((state) => state.busy);
  const data = useMemorySettingsStore((state) => state.data);
  const loadState = useMemorySettingsStore((state) => state.loadState);

  useEffect(() => {
    void refreshMemorySettings().catch(() => undefined);
  }, []);

  if (!data) {
    return loadState === "error" ? (
      <div className="v2-settings-note" role="alert">
        <span>{t("settings.loadError")}</span>
        <UiV2Button onClick={() => void refreshMemorySettings(true).catch(() => undefined)}>{t("settings.retry")}</UiV2Button>
      </div>
    ) : (
      <p className="v2-settings-note" role="status">{t("settings.loading")}</p>
    );
  }

  const managementAvailable = data.capabilities.managementAvailable;
  const active = data.status === "ON";
  const statusLabel = data.status === "NEEDS_ADMIN_SETUP"
    ? "Memory needs administrator setup"
    : data.status === "PAUSED"
      ? "Memory is paused"
      : data.status === "ON"
        ? "Memory is active"
        : data.status === "PREPARING"
          ? "Memory is preparing"
          : "Memory is unavailable";
  const statusDetail = active
    ? t("settings.intro")
    : data.status === "PAUSED"
      ? "Answers ignore saved memories until you resume."
      : t("settings.temporaryDescription");
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

  return (
    <>
      <div className="v2-settings-status-card" data-state={active ? "on" : "off"} data-testid="settings-memory-status">
        <div className="v2-settings-status-card-copy">
          <span className="v2-settings-status-dot" aria-hidden="true" />
          <div>
            <strong>{statusLabel}</strong>
            <small>{statusDetail}</small>
          </div>
        </div>
        {managementAvailable ? (
          <UiV2Button
            disabled={busy !== null}
            onClick={() => gate("useMemoryFacts", !data.settings.useMemoryFacts)}
          >
            {data.settings.useMemoryFacts ? "Pause" : "Resume"}
          </UiV2Button>
        ) : null}
      </div>
      {rows.map((row, index) => {
        const pausedByMaster = index > 0 && !data.settings.useMemoryFacts;
        return (
          <SettingsRowV2 description={row.description} key={row.key} title={row.label}>
            <SettingsSwitchV2
              checked={row.value && !pausedByMaster}
              disabled={busy !== null || !managementAvailable || !row.available || pausedByMaster}
              label={`${row.label}: ${row.value && !pausedByMaster ? "on" : "off"}`}
              onChange={(next) => gate(row.key, next)}
            />
          </SettingsRowV2>
        );
      })}
      <p className="v2-settings-note">
        <UiV2Icon name="chat" />
        <span>{t("settings.temporaryDescription")}</span>
      </p>
      <SettingsRowV2 description={t("settings.manageDescription")} title={t("settings.manageLabel")}>
        <UiV2Button disabled={!managementAvailable} icon="chevron-right" onClick={onManage}>
          Open
        </UiV2Button>
      </SettingsRowV2>
    </>
  );
}
