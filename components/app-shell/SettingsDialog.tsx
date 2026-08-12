import { DiscardChangesConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { McpSettingsSection } from "@/components/app-shell/McpSettingsSection";
import { ShellNotice } from "@/components/app-shell/ShellNotice";
import type { SettingsSection } from "@/components/app-shell/settingsDestinationStore";
import { AIQSA_THEMES, type ThemeId } from "@/components/app-shell/theme";
import type { Notice } from "@/components/app-shell/types";
import { Check, Palette, Wrench, X } from "lucide-react";
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useDialogFocus } from "./useDialogFocus";

type GeneralSettingsSection = SettingsSection;

type DiscardIntent =
  | { kind: "close" }
  | { kind: "section"; section: GeneralSettingsSection };

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-overlay-surface";
const coarsePointerTarget = "[@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch";

export function SettingsDialog({
  initialSection = "appearance",
  notice = null,
  onClose,
  onDismissNotice,
  onThemeChange,
  restoreFocus,
  themeId
}: {
  initialSection?: GeneralSettingsSection;
  notice?: Notice | null;
  onClose(): void;
  onDismissNotice?(): void;
  onThemeChange(themeId: ThemeId): void;
  restoreFocus?(): HTMLElement | null;
  themeId: ThemeId;
}) {
  const [activeSection, setActiveSection] = useState<GeneralSettingsSection>(initialSection);
  const [discardIntent, setDiscardIntent] = useState<DiscardIntent | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpDirty, setMcpDirty] = useState(false);
  const themeRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const discardConfirmationOpen = discardIntent !== null;
  const settingsBusy = mcpBusy;
  const settingsDirty = activeSection === "mcp" && mcpDirty;

  const requestClose = () => {
    if (settingsBusy) {
      return;
    }
    if (settingsDirty) {
      setDiscardIntent({ kind: "close" });
      return;
    }
    onClose();
  };
  const dialogRef = useDialogFocus<HTMLDivElement>({
    autoFocus: false,
    closeOnEscape: !discardConfirmationOpen,
    containFocus: !discardConfirmationOpen,
    onClose: requestClose,
    restoreFocus
  });

  function requestSection(section: GeneralSettingsSection) {
    if (settingsBusy || section === activeSection) {
      return;
    }
    if (settingsDirty) {
      setDiscardIntent({ kind: "section", section });
      return;
    }
    setActiveSection(section);
  }

  function confirmDiscard() {
    const intent = discardIntent;
    setDiscardIntent(null);
    if (!intent) {
      return;
    }

    if (intent.kind === "close") {
      onClose();
      return;
    }
    if (activeSection === "mcp") setMcpDirty(false);
    setActiveSection(intent.section);
  }

  function handleThemeKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      nextIndex = (index + 1) % AIQSA_THEMES.length;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      nextIndex = (index - 1 + AIQSA_THEMES.length) % AIQSA_THEMES.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = AIQSA_THEMES.length - 1;
    }

    if (nextIndex === null) {
      return;
    }
    event.preventDefault();
    const theme = AIQSA_THEMES[nextIndex];
    onThemeChange(theme.id);
    themeRefs.current[nextIndex]?.focus();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-scrim/65 sm:items-center sm:pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:pl-[max(1.25rem,env(safe-area-inset-left))] sm:pr-[max(1.25rem,env(safe-area-inset-right))] sm:pt-[max(1.25rem,env(safe-area-inset-top))] [@media(max-height:32rem)]:!pb-[max(.5rem,env(safe-area-inset-bottom))] [@media(max-height:32rem)]:!pl-[max(.5rem,env(safe-area-inset-left))] [@media(max-height:32rem)]:!pr-[max(.5rem,env(safe-area-inset-right))] [@media(max-height:32rem)]:!pt-[max(.5rem,env(safe-area-inset-top))]"
      data-testid="settings-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) {
          requestClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="pop-enter flex h-[100dvh] w-full max-w-4xl flex-col overflow-hidden bg-overlay-surface pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] text-ink shadow-overlay sm:h-[min(48rem,calc(100dvh-2.5rem))] sm:rounded-panel sm:border sm:border-trace-subtle sm:p-0 [@media(max-height:32rem)]:!h-full [@media(max-height:32rem)]:!max-h-full"
        role="dialog"
        aria-modal="true"
        aria-hidden={discardConfirmationOpen || undefined}
        aria-label="Settings"
        aria-busy={settingsBusy}
        data-testid="settings-dialog"
        inert={discardConfirmationOpen || undefined}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="relative z-10 flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-trace-subtle bg-overlay-surface px-4 sm:px-5">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-ink">Settings</h2>
            <p className="mt-0.5 truncate text-xs text-ink-muted">Appearance and personal tool connections</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {settingsBusy || settingsDirty ? (
              <span className="hidden text-xs font-medium text-caution sm:inline" role="status">
                {settingsBusy
                  ? "Updating MCP settings…"
                  : "Unsaved MCP values"}
              </span>
            ) : null}
            <button
              className={`grid size-11 place-items-center rounded-control text-ink-muted hover:bg-control-hover hover:text-ink sm:size-9 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11 ${focusRing}`}
              type="button"
              aria-label="Close settings"
              disabled={settingsBusy}
              title={settingsBusy
                ? "Wait for the MCP update to finish"
                : "Close settings"}
              onClick={requestClose}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        </header>

        <nav
          className="relative z-10 flex shrink-0 gap-1 border-b border-trace-subtle bg-overlay-surface px-2 py-2 sm:px-4"
          aria-label="Settings sections"
        >
          <button
            className={[
              `flex min-h-touch min-w-0 flex-1 items-center justify-center gap-2 rounded-control px-3 text-sm font-medium disabled:cursor-not-allowed disabled:text-ink-disabled sm:min-h-control sm:flex-none sm:justify-start ${coarsePointerTarget} ${focusRing}`,
              activeSection === "appearance"
                ? "bg-control-selected text-ink"
                : "text-ink-secondary hover:bg-control-hover hover:text-ink"
            ].join(" ")}
            type="button"
            aria-current={activeSection === "appearance" ? "page" : undefined}
            disabled={settingsBusy && activeSection !== "appearance"}
            onClick={() => requestSection("appearance")}
          >
            <Palette className="size-4 text-ink-muted" aria-hidden="true" />
            Appearance
          </button>
          <button
            className={[
              `flex min-h-touch min-w-0 flex-1 items-center justify-center gap-2 rounded-control px-3 text-sm font-medium disabled:cursor-not-allowed disabled:text-ink-disabled sm:min-h-control sm:flex-none sm:justify-start ${coarsePointerTarget} ${focusRing}`,
              activeSection === "mcp"
                ? "bg-control-selected text-ink"
                : "text-ink-secondary hover:bg-control-hover hover:text-ink"
            ].join(" ")}
            type="button"
            aria-current={activeSection === "mcp" ? "page" : undefined}
            disabled={settingsBusy && activeSection !== "mcp"}
            onClick={() => requestSection("mcp")}
          >
            <Wrench className="size-4 text-ink-muted" aria-hidden="true" />
            MCP &amp; tools
          </button>
        </nav>

        {notice ? (
          <div
            className="relative z-10 flex shrink-0 justify-center border-b border-trace-subtle bg-overlay-surface px-3 py-2"
            data-testid="settings-notice-region"
          >
            <ShellNotice notice={notice} onDismiss={onDismissNotice ?? (() => undefined)} />
          </div>
        ) : null}

        {activeSection === "mcp" ? (
          <McpSettingsSection onBusyChange={setMcpBusy} onDirtyChange={setMcpDirty} />
        ) : (
          <section
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-6 sm:px-6"
            aria-labelledby="appearance-heading"
            data-testid="settings-appearance-scroll"
          >
            <div className="mx-auto max-w-3xl">
              <h3 className="text-base font-semibold text-ink" id="appearance-heading">Appearance</h3>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-secondary">
                Choose an AIQSA palette. The change applies immediately across this browser.
              </p>
              <p className="mt-2 max-w-2xl text-xs leading-5 text-ink-muted">
                This theme is saved only in this browser and does not follow your account.
              </p>

              <div className="mt-6 divide-y divide-trace-subtle border-y border-trace-subtle" role="radiogroup" aria-label="Theme">
                {AIQSA_THEMES.map((theme, index) => {
                  const selected = theme.id === themeId;

                  return (
                    <button
                      ref={(node) => {
                        themeRefs.current[index] = node;
                      }}
                      key={theme.id}
                      className={[
                        `grid min-h-touch w-full min-w-0 grid-cols-[5.5rem_minmax(0,1fr)_auto] items-center gap-3 px-2 py-3 text-left ${focusRing}`,
                        selected
                          ? "bg-control-selected text-ink"
                          : "text-ink-secondary hover:bg-control-hover hover:text-ink"
                      ].join(" ")}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={`Use ${theme.name} theme, ${theme.description}`}
                      tabIndex={selected ? 0 : -1}
                      onClick={() => onThemeChange(theme.id)}
                      onKeyDown={(event) => handleThemeKeyDown(event, index)}
                    >
                      <span
                        className="block h-14 overflow-hidden rounded-control border border-trace-subtle bg-app-canvas p-1.5"
                        data-theme={theme.id}
                        aria-hidden="true"
                      >
                        <span className="flex h-3 items-center justify-between rounded-control bg-workspace-rail px-1">
                          <span className="h-1 w-6 rounded-pill bg-ink-muted/60" />
                          <span className="size-1 rounded-pill bg-proof" />
                        </span>
                        <span className="mt-1.5 grid h-8 grid-cols-[1.25rem_minmax(0,1fr)] gap-1">
                          <span className="rounded-control bg-workspace-rail" />
                          <span className="rounded-control bg-answer-paper p-1">
                            <span className="block h-1 w-4/5 rounded-pill bg-ink-muted/45" />
                            <span className="mt-1 block h-3 rounded-control bg-control-surface" />
                            <span className="mt-1 block h-1 w-1/2 rounded-pill bg-proof/75" />
                          </span>
                        </span>
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-ink">{theme.name}</span>
                        <span className="mt-0.5 block text-xs leading-5 text-ink-muted">{theme.description} · {theme.accentLabel} accent</span>
                      </span>
                      <span className={`inline-flex items-center gap-1 text-xs font-medium ${selected ? "text-proof" : "text-ink-muted"}`}>
                        {selected ? <Check className="size-4 shrink-0" aria-hidden="true" /> : null}
                        <span className="hidden sm:inline">{selected ? "Current" : "Select"}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </section>
        )}
      </div>

      {discardConfirmationOpen ? (
        <DiscardChangesConfirmationDialog
          label="MCP settings"
          onCancel={() => setDiscardIntent(null)}
          onConfirm={confirmDiscard}
        />
      ) : null}
    </div>
  );
}
