"use client";

import {
  type UiV2IconName,
  UiV2Button,
  UiV2Icon,
  UiV2IconButton,
  UiV2IconSprite,
  UiV2Monogram,
  UiV2Switch
} from "@/components/ui-v2";
import {
  AIQSA_THEMES,
  type ThemeId
} from "@/components/app-shell/theme";
import { createPortal } from "react-dom";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from "react";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";

export type SettingsSectionV2 =
  | "account"
  | "connected_apps"
  | "data"
  | "defaults"
  | "general"
  | "mcp"
  | "memory";

type SettingsIntentV2 =
  | Readonly<{ kind: "close" }>
  | Readonly<{ kind: "section"; section: SettingsSectionV2 }>;

const SECTION_ORDER: readonly SettingsSectionV2[] = [
  "general",
  "defaults",
  "memory",
  "connected_apps",
  "mcp",
  "data",
  "account"
];

const SECTION_META: Record<SettingsSectionV2, Readonly<{ icon: UiV2IconName; label: string }>> = {
  account: { icon: "assistant", label: "Account" },
  connected_apps: { icon: "lock", label: "Connected apps" },
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

/** The Settings row switch: the shared `UiV2Switch` (role="switch"). */
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
  return <UiV2Switch checked={checked} disabled={disabled} label={label} onChange={onChange} />;
}

export function SettingsV2({
  busy = false,
  busyMessage = "Updating settings…",
  connectedAppsContent,
  dirty = false,
  generalSlot = null,
  initialSection = "general",
  mcpContent,
  noticeSlot,
  obscured = false,
  onClose,
  onDiscard,
  onSectionChange,
  onThemeChange,
  panels = {},
  subview,
  themeId
}: Readonly<{
  busy?: boolean;
  busyMessage?: string;
  connectedAppsContent: ReactNode;
  dirty?: boolean;
  /** Rows rendered under the Theme rows of the General tab. */
  generalSlot?: ReactNode;
  initialSection?: SettingsSectionV2;
  mcpContent: ReactNode;
  noticeSlot?: ReactNode;
  /** True while a nested confirmation dialog owns interaction above Settings. */
  obscured?: boolean;
  onClose(): void;
  onDiscard?(): void;
  onSectionChange?(section: SettingsSectionV2): void;
  onThemeChange(theme: ThemeId): void;
  /** Bodies of the remaining tabs; a tab without a body is not listed. */
  panels?: Partial<Record<Exclude<SettingsSectionV2, "connected_apps" | "general" | "mcp">, ReactNode>>;
  /** A task owned by the active Settings section, rendered under its breadcrumb. */
  subview?: Readonly<{ label: string; onBack(): void }>;
  themeId: ThemeId;
}>) {
  const available = SECTION_ORDER.filter((section) =>
    section === "connected_apps" || section === "general" || section === "mcp" || panels[section] !== undefined
  );
  const [activeSection, setActiveSection] = useState<SettingsSectionV2>(
    available.includes(initialSection) ? initialSection : "general"
  );
  const [discardIntent, setDiscardIntent] = useState<SettingsIntentV2 | null>(null);
  const sectionNavRef = useRef<HTMLElement | null>(null);
  const sectionRefs = useRef<Partial<Record<SettingsSectionV2, HTMLButtonElement | null>>>({});
  const subviewBackRef = useRef<HTMLButtonElement | null>(null);
  const themeRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const applyIntent = (intent: SettingsIntentV2) => {
    if (intent.kind === "close") {
      onClose();
      return;
    }
    onSectionChange?.(intent.section);
    setActiveSection(intent.section);
  };
  const request = (intent: SettingsIntentV2) => {
    if (busy) return;
    if (dirty && activeSection === "mcp") {
      setDiscardIntent(intent);
      return;
    }
    applyIntent(intent);
  };
  const {
    dialogRef,
    initialFocusRef,
    onDialogKeyDown,
    portalReady
  } = useModalLayerV2({
    closeBlocked: busy || discardIntent !== null || obscured,
    onClose: () => request({ kind: "close" })
  });

  const confirmDiscard = () => {
    const intent = discardIntent;
    if (!intent) return;
    onDiscard?.();
    setDiscardIntent(null);
    applyIntent(intent);
  };

  useEffect(() => {
    if (subview?.label) subviewBackRef.current?.focus();
  }, [subview?.label]);

  // Mobile Settings keeps all destinations in one horizontal strip. Reveal a
  // selected deep-link (for example Data) without stealing focus from the
  // dialog's deliberate entry control.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const nav = sectionNavRef.current;
      const tab = sectionRefs.current[activeSection];
      if (!nav || !tab || nav.scrollWidth <= nav.clientWidth) return;
      tab.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeSection]);

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
        aria-hidden={discardIntent !== null || obscured || undefined}
        aria-label="Settings"
        aria-modal="true"
        className="v2-settings-dialog"
        data-testid="settings-v2"
        inert={discardIntent !== null || obscured || undefined}
        role="dialog"
        onKeyDown={onDialogKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <UiV2IconSprite />
        {/* Left column: the vertical tabs (PRD §4.9). */}
        <nav ref={sectionNavRef} className="v2-settings-nav" aria-label="Settings sections">
          <h1>Settings</h1>
          {available.map((section) => (
            <button
              ref={(node) => { sectionRefs.current[section] = node; }}
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
          <div className="v2-settings-heading">
            {subview ? (
              <UiV2IconButton
                ref={subviewBackRef}
                disabled={busy}
                icon="arrow-left"
                label={`Back to ${activeMeta.label}`}
                onClick={subview.onBack}
              />
            ) : null}
            <h2
              aria-label={subview ? `${activeMeta.label} / ${subview.label}` : undefined}
              id={`v2-settings-${activeSection}-heading`}
            >
              {activeMeta.label}
              {subview ? <><span> / </span><strong>{subview.label}</strong></> : null}
            </h2>
          </div>
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
            {busy ? busyMessage : "Unsaved MCP values"}
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
          ) : activeSection === "connected_apps" ? (
            <section className="v2-settings-section" aria-labelledby="v2-settings-connected_apps-heading">
              <p className="v2-settings-intro">
                Review external applications that you authorized to use Personal Memory.
              </p>
              <div className="v2-settings-owner-slot" data-testid="settings-connected-apps-owner">
                {connectedAppsContent}
              </div>
            </section>
          ) : activeSection === "mcp" ? (
            <section className="v2-settings-section" aria-labelledby="v2-settings-mcp-heading">
              {/* The owner renders the one status row and the server rows
                  (UX audit 2026-09-02 A13): no second intro above them. */}
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
  const enabled = servers.filter((server) => server.enabled);
  const tools = enabled.reduce((total, server) => total + server.tools, 0);
  return (
    <div className="v2-settings-mcp">
      <SettingsRowV2
        description="Enabled servers join your private tool catalog; a chat uses them only in Auto or Load all mode."
        title={`${enabled.length} of ${servers.length} servers enabled${tools ? ` · ${tools} tools` : ""}`}
      >
        <UiV2Button className="v2-settings-quiet-action">Refresh status</UiV2Button>
      </SettingsRowV2>
      <div className="v2-settings-server-list" aria-label="MCP servers" role="list">
        {servers.map((server) => (
          <article className="v2-settings-server" data-enabled={server.enabled || undefined} key={server.id} role="listitem">
            <div className="v2-settings-server-head">
              <UiV2Monogram className="v2-settings-server-mark" label={server.name} />
              <div className="v2-settings-server-copy">
                <h4>{server.name}</h4>
                <p className="v2-settings-server-description">{server.detail}</p>
                <p className="v2-settings-server-status">
                  <span className="v2-settings-server-availability" data-resource-availability={server.enabled ? "enabled" : "disabled"}>
                    {server.enabled ? "Enabled" : "Disabled"}
                  </span>
                  {server.enabled ? (
                    <>
                      <span aria-hidden="true"> · </span>
                      <span className="v2-settings-server-readiness" data-tone={server.ready ? "ok" : "warn"}>
                        <UiV2Icon name={server.ready ? "check" : "alert"} />
                        {server.ready ? "Ready" : "Needs setup"}
                      </span>
                      {server.tools ? <><span aria-hidden="true"> · </span><span>{server.tools} tools</span></> : null}
                    </>
                  ) : null}
                </p>
              </div>
              <div className="v2-settings-server-action">
                {server.ready || !server.enabled
                  ? <UiV2Switch checked={server.enabled} label={server.name} onChange={() => undefined} />
                  : <UiV2Button tone="primary">Complete setup</UiV2Button>}
              </div>
            </div>
          </article>
        ))}
      </div>
      <details className="v2-settings-footnote">
        <summary className="v2-focusable">How tools use data</summary>
        <div className="v2-settings-disclosure-body">
          <p>Auto starts with a small schema-free catalog and loads only matching tools when the model asks.</p>
        </div>
      </details>
    </div>
  );
}
