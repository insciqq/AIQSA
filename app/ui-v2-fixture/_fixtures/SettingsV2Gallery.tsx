"use client";

import { UiV2Button } from "@/components/ui-v2";
import { PermanentChatDeletionSurface } from "@/components/app-shell/PermanentChatDeletionSurface";
import { removePermanentlyDeletedArchivedChat } from "@/components/app-shell/archivedChatsStore";
import {
  activatePermanentChatDeletionAccount,
  usePermanentChatDeletionStore
} from "@/components/app-shell/permanentChatDeletionStore";
import {
  activateMemorySettings,
  useMemorySettingsStore
} from "@/components/app-shell/memorySettingsStore";
import { applyThemeId, type ThemeId } from "@/components/app-shell/theme";
import type { MemoryConsumerSettingsResponse } from "@/lib/contracts/memoryConsumer";
import { useRef, useState } from "react";
import {
  McpSettingsSummaryV2,
  SettingsRowV2,
  SettingsV2
} from "@/features/settings-v2/SettingsV2";
import { MemorySettingsRowsV2 } from "@/features/settings-v2/MemorySettingsRowsV2";
import { ArchivedChatsPanelV2 } from "@/features/settings-v2/ArchivedChatsPanelV2";

export type SettingsGalleryStateV2 = "appearance" | "archived" | "dirty" | "mcp" | "memory";

const archiveMemorySettings: MemoryConsumerSettingsResponse = {
  capabilities: {
    automaticLearningAvailable: true,
    decayAvailable: true,
    managementAvailable: true,
    naturalLanguageActionsAvailable: true,
    permanentChatDeletion: true,
    pastChatIndexingAvailable: true,
    retrievalAvailable: true,
    synthesisAvailable: true,
    temporaryChats: true
  },
  resetState: "IDLE",
  settings: {
    decayEnabled: false,
    learnAutomatically: true,
    referenceChatHistory: true,
    synthesisEnabled: false,
    useMemoryFacts: true
  },
  status: "ON"
};

export function SettingsV2Gallery({ state = "appearance" }: { state?: SettingsGalleryStateV2 }) {
  const [open, setOpen] = useState(true);
  const [dirty, setDirty] = useState(state === "dirty");
  const [dataSubview, setDataSubview] = useState<"archived" | null>(null);
  const archiveManageRef = useRef<HTMLButtonElement | null>(null);
  const deletionObscuresSettings = usePermanentChatDeletionStore(
    (snapshot) => Boolean(snapshot.target) || snapshot.statusOpen
  );
  const [theme, setTheme] = useState<ThemeId>(() => {
    const value = typeof document === "undefined" ? "dark" : document.documentElement.dataset.theme;
    return value === "light" || value === "system" ? value : "dark";
  });
  const updateTheme = (next: ThemeId) => {
    setTheme(next);
    applyThemeId(next);
  };
  const openArchive = () => {
    activateMemorySettings("ui-v2-fixture");
    useMemorySettingsStore.setState({
      data: archiveMemorySettings,
      error: null,
      loadState: "ready"
    });
    void activatePermanentChatDeletionAccount(
      "ui-v2-fixture",
      removePermanentlyDeletedArchivedChat
    );
    setDataSubview("archived");
  };
  const closeArchive = () => {
    setDataSubview(null);
    requestAnimationFrame(() => archiveManageRef.current?.focus());
  };
  return (
    <main className="v2-settings-fixture">
      <h1>Quarterly product brief</h1>
      <p>Settings is a temporary layer over the conversation, not a separate dashboard.</p>
      <UiV2Button onClick={() => setOpen(true)}>Open settings</UiV2Button>
      {open ? (
        <SettingsV2
          connectedAppsContent={(
            <div className="v2-settings-fixture-dirty">
              <p>Codex · Active · Personal Memory facts</p>
              <p>Revoking access keeps stored Memory facts.</p>
            </div>
          )}
          dirty={dirty}
          initialSection={state === "appearance"
            ? "general"
            : state === "memory"
              ? "memory"
              : state === "archived"
                ? "data"
                : "mcp"}
          mcpContent={(
            <>
              <McpSettingsSummaryV2 servers={[
                { detail: "Workspace · OAuth connected", enabled: true, id: "jira", name: "Jira", ready: true, tools: 6 },
                { detail: "Personal setup required", enabled: true, id: "drive", name: "Drive", ready: false, tools: 0 }
              ]} />
              <div className="v2-settings-fixture-dirty">
                <UiV2Button onClick={() => setDirty((value) => !value)}>
                  {dirty ? "Save fixture" : "Edit personal field"}
                </UiV2Button>
              </div>
            </>
          )}
          obscured={deletionObscuresSettings}
          onClose={() => setOpen(false)}
          onDiscard={() => setDirty(false)}
          onSectionChange={() => setDataSubview(null)}
          onThemeChange={updateTheme}
          panels={{
            data: dataSubview === "archived" ? (
              <ArchivedChatsPanelV2 onRestored={() => undefined} />
            ) : (
              <SettingsRowV2
                description="Restore or permanently delete chats you archived."
                title="Archived chats"
              >
                <UiV2Button ref={archiveManageRef} icon="chevron-right" onClick={openArchive}>
                  Manage
                </UiV2Button>
              </SettingsRowV2>
            ),
            memory: <MemorySettingsRowsV2 onOpenLibrary={() => undefined} />
          }}
          subview={dataSubview === "archived"
            ? { label: "Archived chats", onBack: closeArchive }
            : undefined}
          themeId={theme}
        />
      ) : null}
      <PermanentChatDeletionSurface />
    </main>
  );
}
