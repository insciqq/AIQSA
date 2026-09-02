"use client";

import {
  type UiV2IconName,
  UiV2Button,
  UiV2Icon,
  UiV2IconButton,
  UiV2IconSprite
} from "@/components/ui-v2";
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

export type SettingsSectionV2 = "account" | "data" | "defaults" | "general" | "mcp" | "memory";

type SettingsIntentV2 =
  | Readonly<{ kind: "close" }>
  | Readonly<{ kind: "section"; section: SettingsSectionV2 }>;

const SECTION_ORDER: readonly SettingsSectionV2[] = ["general", "defaults", "memory", "mcp", "data", "account"];

const SECTION_META: Record<SettingsSectionV2, Readonly<{ icon: UiV2IconName; label: string }>> = {
  account: { icon: "assistant", label: "Account" },
  data: { icon: "archive", label: "Data" },
  defaults: { icon: "sliders", label: "Chat defaults" },
  general: { icon: "sun", label: "General" },
  mcp: { icon: "tool", label: "MCP & tools" },
  memory: { icon: "memory", label: "Memory" }
};

const THEME_CAPTIONS: Record<ThemeId, string> = {
  dark: "Deep navy",
  light: "Cool paper",
  system: "Follow this device"
};

/** One Settings row: title, subtitle, and the control on the right (PRD §4.9). */
export function SettingsRowV2({
  children,
  description,
  testId,
  title,
  tone
}: Readonly<{
  children?: ReactNode;
  description?: ReactNode;
  testId?: string;
  title: ReactNode;
  tone?: "danger";
}>) {
  return (
    <div className="v2-settings-row" data-testid={testId} data-tone={tone}>
      <div className="v2-settings-row-copy">
        <span className="v2-settings-row-title">{title}</span>
        {description ? <span className="v2-settings-row-description">{description}</span> : null}
      </div>
      {children ? <div className="v2-settings-row-control">{children}</div> : null}
    </div>
  );
}

/** Group label above a run of rows ("Danger zone"). */
export function SettingsGroupLabelV2({ children, tone }: Readonly<{ children: ReactNode; tone?: "danger" }>) {
  return <p className="v2-settings-group-label" data-tone={tone}>{children}</p>;
}

/** Accessible switch: a button with role="switch" and the accent track. */
export function SettingsSwitchV2({
  checked,
  disabled = false,
  label,
  onChange
}: Readonly<{
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange(next: boolean): void;
}>) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className="v2-settings-switch v2-focusable"
      disabled={disabled}
      role="switch"
      type="button"
      onClick={() => onChange(!checked)}
    >
      <span className="v2-settings-switch-track" aria-hidden="true">
        <span className="v2-settings-switch-thumb" />
      </span>
    </button>
  );
}

export function SettingsV2({
  busy = false,
  dirty = false,
  generalSlot = null,
  initialSection = "general",
  mcpContent,
  noticeSlot,
  onClose,
  onDiscard,
  onThemeChange,
  panels = {},
  themeId
}: Readonly<{
  busy?: boolean;
  dirty?: boolean;
  /** Rows rendered under the Theme rows of the General tab. */
  generalSlot?: ReactNode;
  initialSection?: SettingsSectionV2;
  mcpContent: ReactNode;
  noticeSlot?: ReactNode;
  onClose(): void;
  onDiscard?(): void;
  onThemeChange(theme: ThemeId): void;
  /** Bodies of the remaining tabs; a tab without a body is not listed. */
  panels?: Partial<Record<Exclude<SettingsSectionV2, "general" | "mcp">, ReactNode>>;
  themeId: ThemeId;
}>) {
  const available = SECTION_ORDER.filter((section) =>
    section === "general" || section === "mcp" || panels[section] !== undefined
  );
  const [activeSection, setActiveSection] = useState<SettingsSectionV2>(
    available.includes(initialSection) ? initialSection : "general"
  );
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

  const activeMeta = SECTION_META[activeSection];

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
        {/* Left column: the vertical tabs (PRD §4.9). */}
        <nav className="v2-settings-nav" aria-label="Settings sections">
          <h1>Settings</h1>
          {available.map((section) => (
            <button
              aria-current={activeSection === section ? "page" : undefined}
              className="v2-settings-nav-button v2-focusable"
              data-selected={activeSection === section || undefined}
              disabled={busy && activeSection !== section}
              key={section}
              type="button"
              onClick={() => request({ kind: "section", section })}
            >
              <UiV2Icon name={SECTION_META[section].icon} />
              {SECTION_META[section].label}
            </button>
          ))}
        </nav>
        <header className="v2-settings-header">
          <h2 id={`v2-settings-${activeSection}-heading`}>{activeMeta.label}</h2>
          <UiV2IconButton
            ref={initialFocusRef}
            disabled={busy}
            icon="close"
            label="Close settings"
            onClick={() => request({ kind: "close" })}
          />
        </header>
        {busy || dirty ? (
          <p className="v2-settings-state" role="status">
            {busy ? "Updating MCP…" : "Unsaved MCP values"}
          </p>
        ) : null}
        {noticeSlot ? <div className="v2-settings-notice">{noticeSlot}</div> : null}
        <div className="v2-settings-scroll">
          {activeSection === "general" ? (
            <section className="v2-settings-section" aria-labelledby="v2-settings-general-heading">
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
                        <span className="v2-theme-preview-rail" />
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
              {generalSlot}
            </section>
          ) : activeSection === "mcp" ? (
            <section className="v2-settings-section" aria-labelledby="v2-settings-mcp-heading">
              <p className="v2-settings-intro">
                Manage only the connections available to you. Policy, secrets, and the full inventory stay with the administrator.
              </p>
              <div className="v2-settings-owner-slot" data-testid="settings-mcp-owner">
                {mcpContent}
              </div>
            </section>
          ) : (
            <section
              className="v2-settings-section"
              aria-labelledby={`v2-settings-${activeSection}-heading`}
              data-testid={`settings-${activeSection}-panel`}
            >
              {panels[activeSection]}
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
