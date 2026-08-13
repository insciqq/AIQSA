"use client";

import { UiV2Button, UiV2Icon, UiV2IconButton, UiV2IconSprite } from "@/components/ui-v2";
import {
  AIQSA_THEMES,
  type ThemeId
} from "@/components/app-shell/theme";
import { createPortal } from "react-dom";
import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from "react";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";

export type SettingsSectionV2 = "appearance" | "mcp";

type SettingsIntentV2 =
  | Readonly<{ kind: "close" }>
  | Readonly<{ kind: "section"; section: SettingsSectionV2 }>;

export function SettingsV2({
  busy = false,
  dirty = false,
  initialSection = "appearance",
  mcpContent,
  noticeSlot,
  onClose,
  onDiscard,
  onThemeChange,
  themeId
}: Readonly<{
  busy?: boolean;
  dirty?: boolean;
  initialSection?: SettingsSectionV2;
  mcpContent: ReactNode;
  noticeSlot?: ReactNode;
  onClose(): void;
  onDiscard?(): void;
  onThemeChange(theme: ThemeId): void;
  themeId: ThemeId;
}>) {
  const [activeSection, setActiveSection] = useState<SettingsSectionV2>(initialSection);
  const [discardIntent, setDiscardIntent] = useState<SettingsIntentV2 | null>(null);
  const themeRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const request = (intent: SettingsIntentV2) => {
    if (busy) return;
    if (dirty && activeSection === "mcp") {
      setDiscardIntent(intent);
      return;
    }
    if (intent.kind === "close") onClose();
    else setActiveSection(intent.section);
  };
  const {
    dialogRef,
    initialFocusRef,
    onDialogKeyDown,
    portalReady
  } = useModalLayerV2({
    closeBlocked: busy || discardIntent !== null,
    onClose: () => request({ kind: "close" })
  });

  const confirmDiscard = () => {
    const intent = discardIntent;
    if (!intent) return;
    onDiscard?.();
    setDiscardIntent(null);
    if (intent.kind === "close") onClose();
    else setActiveSection(intent.section);
  };

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
    const theme = AIQSA_THEMES[nextIndex];
    onThemeChange(theme.id);
    themeRefs.current[nextIndex]?.focus();
  };

  if (!portalReady) return null;

  return createPortal(
    <div
      className="v2-settings-scrim"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) request({ kind: "close" });
      }}
    >
      <section
        ref={dialogRef}
        aria-busy={busy || undefined}
        aria-hidden={discardIntent !== null || undefined}
        aria-label="Settings"
        aria-modal="true"
        className="v2-settings-dialog"
        data-testid="settings-v2"
        inert={discardIntent !== null || undefined}
        role="dialog"
        onKeyDown={onDialogKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <UiV2IconSprite />
        <header className="v2-settings-header">
          <div>
            <h1>Settings</h1>
            <p>Appearance and your personal tool connections</p>
          </div>
          <UiV2IconButton
            ref={initialFocusRef}
            disabled={busy}
            icon="close"
            label="Close settings"
            onClick={() => request({ kind: "close" })}
          />
        </header>
        <nav className="v2-settings-nav" aria-label="Settings sections">
          <button
            aria-current={activeSection === "appearance" ? "page" : undefined}
            className="v2-settings-nav-button v2-focusable"
            data-selected={activeSection === "appearance" || undefined}
            disabled={busy && activeSection !== "appearance"}
            type="button"
            onClick={() => request({ kind: "section", section: "appearance" })}
          >
            <UiV2Icon name="sun" /> Appearance
          </button>
          <button
            aria-current={activeSection === "mcp" ? "page" : undefined}
            className="v2-settings-nav-button v2-focusable"
            data-selected={activeSection === "mcp" || undefined}
            disabled={busy && activeSection !== "mcp"}
            type="button"
            onClick={() => request({ kind: "section", section: "mcp" })}
          >
            <UiV2Icon name="tool" /> MCP & tools
          </button>
        </nav>
        {busy || dirty ? (
          <p className="v2-settings-state" role="status">
            {busy ? "Updating MCP…" : "Unsaved MCP values"}
          </p>
        ) : null}
        {noticeSlot ? <div className="v2-settings-notice">{noticeSlot}</div> : null}
        <div className="v2-settings-scroll">
          {activeSection === "appearance" ? (
            <section className="v2-settings-section" aria-labelledby="v2-appearance-heading">
              <h2 id="v2-appearance-heading">Appearance</h2>
              <p className="v2-settings-intro">
                Choose System, Light, or Dark. The setting applies immediately and is saved only in this browser.
              </p>
              <div className="v2-theme-options" role="radiogroup" aria-label="Theme">
                {AIQSA_THEMES.map((theme, index) => {
                  const selected = theme.id === themeId;
                  return (
                    <button
                      ref={(node) => { themeRefs.current[index] = node; }}
                      aria-checked={selected}
                      aria-label={`Use ${theme.name} theme, ${theme.description}`}
                      className="v2-theme-option v2-focusable"
                      data-selected={selected || undefined}
                      key={theme.id}
                      role="radio"
                      tabIndex={selected ? 0 : -1}
                      type="button"
                      onClick={() => onThemeChange(theme.id)}
                      onKeyDown={(event) => handleThemeKeyDown(event, index)}
                    >
                      <span className="v2-theme-preview" data-preview-theme={theme.id} aria-hidden="true">
                        {theme.id === "system" ? <UiV2Icon name="monitor" /> : <UiV2Icon name={theme.id === "dark" ? "moon" : "sun"} />}
                        <span /><span />
                      </span>
                      <span className="v2-theme-copy">
                        <strong>{theme.name}</strong>
                        <small>{theme.description}</small>
                      </span>
                      <span className="v2-theme-current">{selected ? <UiV2Icon name="check" /> : null}{selected ? "Current" : "Select"}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          ) : (
            <section className="v2-settings-section" aria-labelledby="v2-mcp-heading">
              <h2 id="v2-mcp-heading">MCP & tools</h2>
              <p className="v2-settings-intro">
                Manage only the connections available to you. Policy, secrets, and the full inventory stay with the administrator.
              </p>
              <div className="v2-settings-owner-slot" data-testid="settings-mcp-owner">
                {mcpContent}
              </div>
            </section>
          )}
        </div>
      </section>
      {discardIntent ? (
        <section
          aria-label="Unsaved MCP changes"
          aria-modal="true"
          className="v2-settings-confirm"
          role="alertdialog"
        >
          <h2>Discard unsaved changes?</h2>
          <p>Changes to your personal MCP connection will be lost.</p>
          <div>
            <UiV2Button onClick={() => setDiscardIntent(null)}>Keep editing</UiV2Button>
            <UiV2Button tone="destructive" onClick={confirmDiscard}>Discard changes</UiV2Button>
          </div>
        </section>
      ) : null}
    </div>,
    document.body
  );
}

export function McpSettingsSummaryV2({
  servers
}: Readonly<{
  servers: readonly Readonly<{
    detail: string;
    enabled: boolean;
    id: string;
    name: string;
    ready: boolean;
    tools: number;
  }>[];
}>) {
  return (
    <ul className="v2-mcp-summary" aria-label="MCP servers">
      {servers.map((server) => (
        <li key={server.id}>
          <span className="v2-mcp-status" data-ready={server.ready || undefined} aria-hidden="true" />
          <div>
            <strong>{server.name}</strong>
            <p>{server.detail}</p>
            <small>{server.enabled ? "Enabled" : "Disabled"} · {server.ready ? `${server.tools} tools ready` : "Needs setup"}</small>
          </div>
          <UiV2Button>{server.ready ? "Configure" : "Connect"}</UiV2Button>
        </li>
      ))}
    </ul>
  );
}
