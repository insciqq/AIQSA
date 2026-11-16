"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type Ref } from "react";
import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import { AIQSA_THEMES, type ThemeId } from "@/components/app-shell/theme";
import { deleteAllPersonalChats } from "@/components/app-shell/accountApi";
import { useControlCenterHref } from "@/components/app-shell/chatRoute";
import { ConnectedAppsSection } from "@/components/app-shell/ConnectedAppsSection";
import {
  openPermanentChatDeletionStatus,
  usePermanentChatDeletionStore
} from "@/components/app-shell/permanentChatDeletionStore";
import type { ShellComposerView } from "@/components/app-shell/powerAppShellV2Contracts";
import { signOutCurrentSession } from "@/components/app-shell/sessionActions";
import { BrowserNotificationsSettingsRowV2 } from "@/features/browser-notifications/BrowserNotificationsV2";
import { SectionHeading } from "@/features/library-v2/LibraryV2";
import { ANSWER_SOUNDS } from "@/lib/contracts/answerSound";
import { AccountSettingsRowsV2 } from "./AccountSettingsRowsV2";
import { ArchivedChatsPanelV2 } from "./ArchivedChatsPanelV2";
import { DataSettingsRowsV2 } from "./DataSettingsRowsV2";
import { ProxyListPanel } from "./ProxyListPanel";
import { SettingsSelectV2 } from "./SettingsSelectV2";
import { SettingsGroupLabelV2, SettingsRowV2, SettingsSwitchV2 } from "./SettingsV2";

/*
 * The Settings sections that were the Settings dialog's tabs: General,
 * Account, Data, Proxies and Claude Code & Codex. The Settings surface
 * (`LibrarySurfaceV2`) owns which one is open and their leave guards.
 */

const THEME_CAPTIONS: Record<ThemeId, string> = {
  dark: "Graphite",
  light: "Paper",
  system: "Follow this device"
};

type GeneralSettingsComposerV2 = Pick<ShellComposerView, "browserNotifications" | "notificationSoundEnabled" |
  "notificationSoundId" | "notificationSoundReady" | "previewAnswerSound" | "selectAnswerSound" | "sendWithEnter" |
  "setSendWithEnter" | "showCitations" | "showReasoningBlocks" | "toggleCitationsVisibility" | "toggleNotificationSound" |
  "toggleReasoningBlockVisibility">;

/** Settings › General: the theme, the answer sound, notifications and how answers read. */
export function GeneralSettingsSectionV2({ composer, onThemeChange, themeId }: Readonly<{
  composer: GeneralSettingsComposerV2;
  onThemeChange(theme: ThemeId): void;
  themeId: ThemeId;
}>) {
  const themeRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const handleThemeKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (index + 1) % AIQSA_THEMES.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (index - 1 + AIQSA_THEMES.length) % AIQSA_THEMES.length;
    } else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = AIQSA_THEMES.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    onThemeChange(AIQSA_THEMES[nextIndex].id);
    themeRefs.current[nextIndex]?.focus();
  };
  return (
    <div className="v2-settings-page" data-testid="settings-general-panel">
      <SectionHeading description="How AIQSA looks and how answers read and announce themselves.">General</SectionHeading>
      <SettingsRowV2
        title="Theme"
        description="Applies immediately and is saved only in this browser."
      />
      {/* The preview cards are the one theme control (a radiogroup;
          UX audit 2026-09-02 B2): no second segment above them. */}
      <div className="v2-theme-previews" role="radiogroup" aria-label="Theme">
        {AIQSA_THEMES.map((theme, index) => {
          const selected = theme.id === themeId;
          return (
            <button
              ref={(node) => { themeRefs.current[index] = node; }}
              aria-checked={selected}
              aria-label={`Use ${theme.name} theme, ${theme.description}`}
              className="v2-theme-preview-card v2-focusable"
              data-selected={selected || undefined}
              key={theme.id}
              role="radio"
              tabIndex={selected ? 0 : -1}
              type="button"
              onClick={() => onThemeChange(theme.id)}
              onKeyDown={(event) => handleThemeKeyDown(event, index)}
            >
              <span className="v2-theme-preview" data-preview-theme={theme.id}>
                <span className="v2-theme-preview-sidebar" />
                <span className="v2-theme-preview-composer"><span /></span>
              </span>
              <span className="v2-theme-preview-copy">
                <strong>{theme.name}</strong>
                <small>{THEME_CAPTIONS[theme.id]}</small>
              </span>
              {selected ? <UiV2Icon className="v2-theme-preview-check" name="check" /> : null}
            </button>
          );
        })}
      </div>
      <AnswerSoundSettingsRowV2 composer={composer} />
      {composer.browserNotifications ? (
        <BrowserNotificationsSettingsRowV2 notifications={composer.browserNotifications} />
      ) : null}
      <SettingsRowV2
        description="Show numbered source citations inside answers."
        title="Citations"
      >
        <SettingsSwitchV2
          checked={composer.showCitations}
          label="Citations"
          onChange={() => composer.toggleCitationsVisibility()}
        />
      </SettingsRowV2>
      <SettingsRowV2
        description="Show the model's reasoning as a disclosure above the answer."
        title="Reasoning blocks"
      >
        <SettingsSwitchV2
          checked={composer.showReasoningBlocks}
          label="Reasoning blocks"
          onChange={() => composer.toggleReasoningBlockVisibility()}
        />
      </SettingsRowV2>
      <SettingsRowV2
        description="Shift+Enter inserts a new line. Off: Enter inserts a new line, Ctrl+Enter sends."
        testId="settings-send-with-enter"
        title="Send with Enter"
      >
        <SettingsSwitchV2
          checked={composer.sendWithEnter}
          label="Send with Enter"
          onChange={(next) => composer.setSendWithEnter(next)}
        />
      </SettingsRowV2>
    </div>
  );
}

export function AnswerSoundSettingsRowV2({ composer }: Readonly<{
  composer: Pick<ShellComposerView, "notificationSoundEnabled" | "notificationSoundId" |
    "notificationSoundReady" | "toggleNotificationSound" | "selectAnswerSound" | "previewAnswerSound">;
}>) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const previewSequence = useRef(0);
  useEffect(() => () => { previewSequence.current += 1; }, []);
  return (
    <SettingsRowV2
      description={previewFailed
        ? <span role="status">Preview could not play. Try Play again or check your browser’s audio settings.</span>
        : "Play a short sound when an answer finishes. Preview also works with sound off."}
      title="Answer sound"
    >
      <SettingsSwitchV2
        checked={composer.notificationSoundEnabled}
        disabled={!composer.notificationSoundReady}
        label="Answer sound"
        onChange={() => composer.toggleNotificationSound()}
      />
      <SettingsSelectV2
        disabled={!composer.notificationSoundReady}
        label="Completion sound"
        options={ANSWER_SOUNDS}
        value={composer.notificationSoundId}
        onChange={(sound) => {
          setPreviewFailed(false);
          composer.selectAnswerSound(sound);
        }}
      />
      <UiV2Button
        aria-label="Play preview"
        disabled={!composer.notificationSoundReady}
        onClick={() => {
          const sequence = ++previewSequence.current;
          setPreviewFailed(false);
          void composer.previewAnswerSound(composer.notificationSoundId).then((played) => {
            if (sequence === previewSequence.current) setPreviewFailed(!played);
          });
        }}
      >Play</UiV2Button>
    </SettingsRowV2>
  );
}

/**
 * Settings › Account: name, password, two-factor sign-in, usage, the Control
 * Center for administrators, and sign out. Unsaved and saving states go to
 * Settings' leave guard.
 */
export function AccountSettingsSectionV2({
  accountEmail,
  accountId,
  adminEntryVisible,
  onBusyChange,
  onDirtyChange,
  onDisplayNameChange
}: Readonly<{
  accountEmail: string | null;
  accountId: string;
  adminEntryVisible: boolean;
  onBusyChange(busy: boolean): void;
  onDirtyChange(dirty: boolean): void;
  onDisplayNameChange(displayName: string): void;
}>) {
  const [signingOut, setSigningOut] = useState(false);
  const [saving, setSaving] = useState(false);
  const [signOutError, setSignOutError] = useState(false);
  const controlCenterHref = useControlCenterHref();
  useEffect(() => { onBusyChange(saving || signingOut); return () => onBusyChange(false); }, [onBusyChange, saving, signingOut]);
  return (
    <div className="v2-settings-page" data-testid="settings-account-panel">
      <SectionHeading description="Your name, sign-in, usage and this browser's session.">Account</SectionHeading>
      <AccountSettingsRowsV2 accountEmail={accountEmail} adminEntryVisible={adminEntryVisible}
        onDisplayNameChange={onDisplayNameChange} onDirtyChange={onDirtyChange} onBusyChange={setSaving} />
      {adminEntryVisible ? (
        <SettingsRowV2
          description="Installation resources, providers, users and policies."
          title="Control Center"
        >
          <a className="v2-button v2-focusable" data-tone="ghost" href={controlCenterHref}>
            <UiV2Icon name="shield" />
            <span>Open</span>
          </a>
        </SettingsRowV2>
      ) : null}
      <SettingsGroupLabelV2>Session</SettingsGroupLabelV2>
      <SettingsRowV2
        description="Ends this browser session and removes unsent drafts from this device."
        title="Sign out"
      >
        <UiV2Button
          busy={signingOut}
          disabled={saving}
          onClick={() => {
            setSigningOut(true);
            setSignOutError(false);
            void signOutCurrentSession({ accountId }).then((result) => {
              if (!result.ok) {
                setSignOutError(true);
                setSigningOut(false);
              }
            });
          }}
        >
          Sign out
        </UiV2Button>
        {signOutError ? <span className="v2-live-menu-error" role="alert">Could not sign out.</span> : null}
      </SettingsRowV2>
    </div>
  );
}

/**
 * Settings › Data: archived chats (a sub-view of this section), pending
 * permanent deletion, export, import and deleting every chat.
 */
export function DataSettingsSectionV2({
  accountId,
  archived,
  manageArchivedRef,
  onChatsChanged,
  onOpenArchived,
  onRestored
}: Readonly<{
  accountId: string;
  /** The archived chats sub-view is open. */
  archived: boolean;
  manageArchivedRef?: Ref<HTMLButtonElement>;
  /** An import or Delete all changed the account's chats. */
  onChatsChanged(): void;
  onOpenArchived(): void;
  onRestored(chatId: string): Promise<void> | void;
}>) {
  return (
    <div className="v2-settings-page" data-testid="settings-data-panel">
      {archived ? <ArchivedChatsPanelV2 onRestored={onRestored} /> : (
        <>
          <SectionHeading description="Archived chats, exporting and importing chats, and deleting them.">Data</SectionHeading>
          <SettingsRowV2
            description="Restore or permanently delete chats you archived."
            title="Archived chats"
          >
            <UiV2Button ref={manageArchivedRef} icon="chevron-right" onClick={onOpenArchived}>
              Manage
            </UiV2Button>
          </SettingsRowV2>
          <SettingsPendingDeletionRowV2 />
          <DataSettingsRowsV2
            accountId={accountId}
            onDeleteAll={deleteAllPersonalChats}
            onDeleted={() => onChatsChanged()}
            onImported={onChatsChanged}
          />
        </>
      )}
    </div>
  );
}

function SettingsPendingDeletionRowV2() {
  const reviewRef = useRef<HTMLButtonElement>(null);
  const reference = usePermanentChatDeletionStore((state) => state.reference);
  const status = usePermanentChatDeletionStore((state) => state.status?.status ?? null);
  const pending = Boolean(reference && status && status !== "COMPLETE");
  return (
    <SettingsRowV2
      description={pending
        ? "A permanent deletion is still in progress."
        : "Nothing is waiting for permanent deletion."}
      title="Pending permanent deletion"
    >
      {pending ? (
        <UiV2Button
          ref={reviewRef}
          icon="chevron-right"
          onClick={() => openPermanentChatDeletionStatus(() => reviewRef.current)}
        >
          Review
        </UiV2Button>
      ) : null}
    </SettingsRowV2>
  );
}

/** Settings › Proxies: the user's own proxies and those administrators share. */
export function ProxiesSettingsSectionV2({ onBusyChange, onDirtyChange }: Readonly<{
  onBusyChange(busy: boolean): void;
  onDirtyChange(dirty: boolean): void;
}>) {
  return (
    <div className="v2-settings-page" data-testid="settings-proxies-panel">
      <SectionHeading>Proxies</SectionHeading>
      <ProxyListPanel audience="personal" onBusyChange={onBusyChange} onDirtyChange={onDirtyChange} />
    </div>
  );
}

/** Settings › Claude Code & Codex: connecting coding agents, and the access each one was granted. */
export function ConnectedAppsSettingsSectionV2({ accountId, onBusyChange }: Readonly<{
  accountId: string;
  onBusyChange(busy: boolean): void;
}>) {
  return (
    <div className="v2-settings-page">
      <SectionHeading description="Connect these and other AI agents to AIQSA.">Claude Code &amp; Codex</SectionHeading>
      <div className="v2-settings-owner-slot" data-testid="settings-connected-apps-owner">
        <ConnectedAppsSection accountId={accountId} onBusyChange={onBusyChange} />
      </div>
    </div>
  );
}
