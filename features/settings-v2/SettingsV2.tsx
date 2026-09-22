"use client";

import {
  type UiV2IconName,
  UiV2Button,
  UiV2Icon,
  UiV2IconButton,
  UiV2IconSprite,
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
import { useDialogFocus } from "@/components/app-shell/useDialogFocus";

export type SettingsSectionV2 =
  | "account"
  | "connected_apps"
  | "data"
  | "general";

type SettingsIntentV2 =
  | Readonly<{ kind: "close" }>
  | Readonly<{ kind: "section"; section: SettingsSectionV2 }>;

const SECTION_ORDER: readonly SettingsSectionV2[] = ["general", "account", "connected_apps", "data"];
const SECTION_META: Record<SettingsSectionV2, Readonly<{ icon: UiV2IconName; label: string }>> = {
  general: { icon: "sun", label: "General" },
  account: { icon: "assistant", label: "Account" },
  connected_apps: { icon: "link", label: "Connected apps" },
  data: { icon: "archive", label: "Data" }
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
  noticeSlot?: ReactNode;
  /** True while a nested confirmation dialog owns interaction above Settings. */
  obscured?: boolean;
  onClose(): void;
  onDiscard?(): void;
  onSectionChange?(section: SettingsSectionV2): void;
  onThemeChange(theme: ThemeId): void;
  /** Bodies of the remaining tabs; a tab without a body is not listed. */
  panels?: Partial<Record<Exclude<SettingsSectionV2, "connected_apps" | "general">, ReactNode>>;
  /** A task owned by the active Settings section, rendered under its breadcrumb. */
  subview?: Readonly<{ label: string; onBack(): void }>;
  themeId: ThemeId;
}>) {
  const available = SECTION_ORDER.filter((section) =>
    section === "connected_apps" || section === "general" || panels[section] !== undefined
  );
  const [activeSection, setActiveSection] = useState<SettingsSectionV2>(
    available.includes(initialSection) ? initialSection : "general"
  );
  const [discardIntent, setDiscardIntent] = useState<SettingsIntentV2 | null>(null);
  const discardRef = useDialogFocus<HTMLElement>({ active: discardIntent !== null, onClose: () => setDiscardIntent(null) });
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
    if (intent.kind === "section" && intent.section === activeSection) return;
    if (dirty) {
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
            {busy ? busyMessage : "Unsaved account changes"}
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
          ref={discardRef}
          aria-label="Unsaved account changes"
          aria-modal="true"
          className="v2-settings-confirm"
          role="alertdialog"
        >
          <h2>Discard unsaved changes?</h2>
          <p>Your unsaved account changes will be lost.</p>
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
