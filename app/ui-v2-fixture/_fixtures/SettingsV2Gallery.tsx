"use client";

import { UiV2Button } from "@/components/ui-v2";
import { DiscardChangesConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { PermanentChatDeletionSurface } from "@/components/app-shell/PermanentChatDeletionSurface";
import { removePermanentlyDeletedArchivedChat } from "@/components/app-shell/archivedChatsStore";
import {
  activatePermanentChatDeletionAccount
} from "@/components/app-shell/permanentChatDeletionStore";
import { applyThemeId, type ThemeId } from "@/components/app-shell/theme";
import type { AnswerSoundId } from "@/lib/contracts/answerSound";
import { useEffect, useRef, useState } from "react";
import { LibraryV2, SectionHeading } from "@/features/library-v2/LibraryV2";
import type { LibraryTabIdV2, LibraryTabV2 } from "@/features/library-v2/contracts";
import { SettingsRowV2 } from "@/features/settings-v2/SettingsV2";
import { GeneralSettingsSectionV2 } from "@/features/settings-v2/SettingsSectionsV2";
import { ArchivedChatsPanelV2 } from "@/features/settings-v2/ArchivedChatsPanelV2";
import { PersonalMcpConnectionsSection } from "@/components/app-shell/PersonalMcpConnectionsSection";
import { consumeMcpOAuthReturn } from "@/components/app-shell/mcpSettingsStore";
import { deactivatePersonalMcp } from "@/components/app-shell/personalMcpStore";
import { TelegramConnectionSection } from "@/components/app-shell/TelegramConnectionSection";
import { installPersonalMcpFixtureApi, type PersonalMcpFixtureScenario } from "./personalMcpFixtureApi";
import { installTelegramFixtureApi, type TelegramUserFixtureScenario } from "./telegramFixtureApi";

export type SettingsGalleryStateV2 =
  | "appearance"
  | "archived"
  | "dirty"
  | "account"
  | "connections"
  | "connections-empty"
  | "connections-error"
  | "connections-rows"
  | "telegram-access-off"
  | "telegram-bot-changed"
  | "telegram-linked"
  | "telegram-not-linked";

/**
 * `connections` reads the real routes (browser tests mock them); the other
 * connection states answer from the in-browser fixture API.
 */
function connectionsScenario(state: SettingsGalleryStateV2): PersonalMcpFixtureScenario | null {
  if (state.startsWith("telegram-")) return "empty";
  return state === "connections-empty" ? "empty" : state === "connections-error" ? "error" : state === "connections-rows" ? "rows" : null;
}

/** `telegram-*` states open Settings › Telegram, answering from the fixture API. */
function telegramScenario(state: SettingsGalleryStateV2): TelegramUserFixtureScenario | null {
  return state.startsWith("telegram-") ? state.slice("telegram-".length) as TelegramUserFixtureScenario : null;
}

function initialSection(state: SettingsGalleryStateV2): LibraryTabIdV2 {
  if (state === "appearance") return "general";
  if (state === "archived") return "data";
  if (state.startsWith("connections")) return "mcp";
  return state.startsWith("telegram-") ? "telegram" : "account";
}

/**
 * The sections of Settings that were the Settings dialog, on the Settings
 * surface: General, Account (a fixture form that turns unsaved), Data with
 * archived chats, MCP servers' personal connections, Telegram and
 * Claude Code & Codex.
 */
export function SettingsV2Gallery({ state = "appearance" }: { state?: SettingsGalleryStateV2 }) {
  const scenario = connectionsScenario(state);
  const telegram = telegramScenario(state);
  const [fixtureApiReady, setFixtureApiReady] = useState(scenario === null);
  useEffect(() => {
    if (!scenario) return;
    deactivatePersonalMcp();
    const restorePersonal = installPersonalMcpFixtureApi(scenario);
    const restoreTelegram = telegram ? installTelegramFixtureApi({ user: telegram }) : () => undefined;
    const restore = () => {
      restoreTelegram();
      restorePersonal();
    };
    // `?settings=connections&oauth=…&server=…` previews an OAuth return.
    consumeMcpOAuthReturn(new URL(window.location.href));
    const frame = window.requestAnimationFrame(() => setFixtureApiReady(true));
    return () => {
      window.cancelAnimationFrame(frame);
      restore();
      deactivatePersonalMcp();
    };
  }, [scenario, telegram]);
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<LibraryTabIdV2>(() => initialSection(state));
  const [dirty, setDirty] = useState(state === "dirty");
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [archived, setArchived] = useState(false);
  const archiveManageRef = useRef<HTMLButtonElement | null>(null);
  const [theme, setTheme] = useState<ThemeId>(() => {
    const value = typeof document === "undefined" ? "dark" : document.documentElement.dataset.theme;
    return value === "light" || value === "system" ? value : "dark";
  });
  const [answerSound, setAnswerSound] = useState<{ enabled: boolean; id: AnswerSoundId }>({ enabled: true, id: "rise" });
  const [citations, setCitations] = useState(true);
  const [reasoning, setReasoning] = useState(true);
  const [sendWithEnter, setSendWithEnter] = useState(true);
  const updateTheme = (next: ThemeId) => {
    setTheme(next);
    applyThemeId(next);
  };
  const openArchive = () => {
    void activatePermanentChatDeletionAccount(
      "ui-v2-fixture",
      removePermanentlyDeletedArchivedChat
    );
    setArchived(true);
  };
  const closeArchive = () => {
    setArchived(false);
    requestAnimationFrame(() => archiveManageRef.current?.focus());
  };

  if (!open) {
    return (
      <main className="v2-library-fixture-return">
        <p>The chat is open again.</p>
        <UiV2Button onClick={() => setOpen(true)}>Open Settings</UiV2Button>
      </main>
    );
  }
  if (!fixtureApiReady) return null;

  const tabs: LibraryTabV2[] = [
    {
      id: "general",
      label: "General",
      content: (
        <GeneralSettingsSectionV2
          composer={{
            notificationSoundEnabled: answerSound.enabled,
            notificationSoundId: answerSound.id,
            notificationSoundReady: true,
            previewAnswerSound: async () => true,
            selectAnswerSound: (id) => setAnswerSound((current) => ({ ...current, id })),
            sendWithEnter,
            setSendWithEnter,
            showCitations: citations,
            showReasoningBlocks: reasoning,
            toggleCitationsVisibility: () => setCitations((value) => !value),
            toggleNotificationSound: () => setAnswerSound((current) => ({ ...current, enabled: !current.enabled })),
            toggleReasoningBlockVisibility: () => setReasoning((value) => !value)
          }}
          onThemeChange={updateTheme}
          themeId={theme}
        />
      )
    },
    {
      id: "account",
      label: "Account",
      content: (
        <div className="v2-settings-page" data-testid="settings-account-panel">
          <SectionHeading description="Account section composition fixture.">Account</SectionHeading>
          <SettingsRowV2 title="Display name" description="Shown next to your questions.">
            <UiV2Button onClick={() => setDirty(value => !value)}>{dirty ? "Save fixture" : "Edit display name"}</UiV2Button>
          </SettingsRowV2>
        </div>
      )
    },
    {
      id: "data",
      label: "Data",
      content: (
        <div className="v2-settings-page" data-testid="settings-data-panel">
          {archived ? <ArchivedChatsPanelV2 onRestored={() => undefined} /> : (
            <>
              <SectionHeading description="Data section composition fixture.">Data</SectionHeading>
              <SettingsRowV2
                description="Restore or permanently delete chats you archived."
                title="Archived chats"
              >
                <UiV2Button ref={archiveManageRef} icon="chevron-right" onClick={openArchive}>
                  Manage
                </UiV2Button>
              </SettingsRowV2>
            </>
          )}
        </div>
      )
    },
    {
      id: "mcp",
      label: "MCP servers",
      content: <div className="v2-settings-page"><PersonalMcpConnectionsSection /></div>
    },
    ...(telegram ? [{ id: "telegram" as const, label: "Telegram", content: <TelegramConnectionSection /> }] : []),
    {
      id: "apps",
      label: "Claude Code & Codex",
      content: (
        <div className="v2-settings-page">
          <SectionHeading description="Connect these and other AI agents to AIQSA.">Claude Code &amp; Codex</SectionHeading>
          <div className="v2-settings-owner-slot" data-testid="settings-connected-apps-owner">
            <p>Codex · Active · MCP Hub</p>
            <p>Revoking access keeps your MCP connections.</p>
          </div>
        </div>
      )
    }
  ];

  return (
    <>
      <LibraryV2
        activeTab={tab}
        navigationGuard={(intent, proceed) => {
          if (dirty && intent.from === "account") setPending(() => proceed);
          else proceed();
        }}
        onBack={() => setOpen(false)}
        onTabChange={(next) => {
          setTab(next);
          setArchived(false);
        }}
        subview={tab === "data" && archived
          ? { backLabel: "Back to Data", key: "data-archived", label: "Archived chats", onBack: closeArchive }
          : null}
        tabs={tabs}
      />
      {pending ? (
        <DiscardChangesConfirmationDialog
          portal
          copy={{
            body: "Your unsaved account changes will be lost.",
            cancelLabel: "Keep editing",
            confirmLabel: "Discard changes",
            dialogLabel: "Unsaved account changes",
            title: "Discard your unsaved account changes?"
          }}
          label="account"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const proceed = pending;
            setPending(null);
            setDirty(false);
            proceed();
          }}
        />
      ) : null}
      <PermanentChatDeletionSurface />
    </>
  );
}
