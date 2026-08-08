import { LoaderCircle, MessageSquareText, ScrollText, Settings, Shield, SquarePen } from "lucide-react";
import {
  useId,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type Ref
} from "react";

const railControlClass =
  "grid size-11 shrink-0 place-items-center rounded-control outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-workspace-rail [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11";

function pointerCanHover(): boolean {
  return typeof window.matchMedia !== "function" || window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

function RailEntry({
  children,
  description
}: {
  children(tooltipId: string): ReactNode;
  description: string;
}) {
  const reactId = useId();
  const tooltipId = `workspace-icon-rail-tooltip-${reactId.replace(/:/g, "")}`;
  const [tooltipVisible, setTooltipVisible] = useState(false);

  function showForPointer(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "touch" && pointerCanHover()) {
      setTooltipVisible(true);
    }
  }

  return (
    <div
      className="relative flex w-12 justify-center"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setTooltipVisible(false);
        }
      }}
      onFocus={() => setTooltipVisible(true)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setTooltipVisible(false);
        }
      }}
      onPointerEnter={showForPointer}
      onPointerLeave={() => setTooltipVisible(false)}
    >
      {children(tooltipId)}
      <span
        className={`pointer-events-none absolute left-[calc(100%+0.5rem)] top-1/2 z-[90] w-max max-w-56 -translate-y-1/2 rounded-control border border-trace-subtle bg-overlay-surface px-2 py-1.5 text-xs leading-5 text-ink-secondary shadow-float transition-[opacity,visibility] duration-150 ${
          tooltipVisible ? "visible opacity-100" : "invisible opacity-0"
        }`}
        data-visible={tooltipVisible ? "true" : undefined}
        id={tooltipId}
        role="tooltip"
      >
        {description}
      </span>
    </div>
  );
}

function guardUnavailableKey(event: KeyboardEvent<HTMLElement>, unavailable: boolean) {
  if (unavailable && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    event.stopPropagation();
  }
}

function actionClass({ current = false, unavailable = false }: { current?: boolean; unavailable?: boolean }) {
  if (unavailable) {
    return `${railControlClass} cursor-not-allowed text-ink-disabled opacity-60`;
  }
  if (current) {
    return `${railControlClass} bg-control-selected text-ink hover:bg-control-hover`;
  }
  return `${railControlClass} text-ink-secondary hover:bg-control-hover hover:text-ink`;
}

export type WorkspaceIconRailProps = {
  accountTrigger(tooltipId: string): ReactNode;
  adminHref: string | null;
  assistantsRef?: Ref<HTMLButtonElement>;
  chatsRef?: Ref<HTMLButtonElement>;
  controlCenterRef?: Ref<HTMLAnchorElement>;
  creatingChat: boolean;
  newChatRef?: Ref<HTMLButtonElement>;
  onNewChat(): void;
  onOpenAssistants(): void;
  onOpenSettings(): void;
  onRestoreChats(): void;
  paneHidden: boolean;
  signingOut: boolean;
  settingsRef?: Ref<HTMLButtonElement>;
  workspaceReady: boolean;
};

export function WorkspaceIconRail({
  accountTrigger,
  adminHref,
  assistantsRef,
  chatsRef,
  controlCenterRef,
  creatingChat,
  newChatRef,
  onNewChat,
  onOpenAssistants,
  onOpenSettings,
  onRestoreChats,
  paneHidden,
  signingOut,
  settingsRef,
  workspaceReady
}: WorkspaceIconRailProps) {
  const newChatUnavailable = creatingChat || !workspaceReady;

  return (
    <nav
      aria-label="Primary navigation"
      className="hidden h-full min-h-0 w-[calc(3rem+env(safe-area-inset-left))] flex-col border-r border-trace-subtle bg-workspace-rail pb-[max(0.5rem,env(safe-area-inset-bottom))] pl-[env(safe-area-inset-left)] pt-[max(0.5rem,env(safe-area-inset-top))] text-ink min-[1281px]:flex"
      data-testid="workspace-icon-rail"
    >
      <div className="flex w-12 flex-1 flex-col items-center gap-1">
        <RailEntry description="Start a blank conversation">
          {(tooltipId) => (
            <button
              ref={newChatRef}
              className={actionClass({ unavailable: newChatUnavailable })}
              type="button"
              aria-disabled={newChatUnavailable || undefined}
              aria-describedby={tooltipId}
              aria-label="New chat"
              data-desktop-navigation-control="new-chat"
              data-testid="workspace-icon-new-chat"
              title="New chat"
              onClick={(event) => {
                if (newChatUnavailable) {
                  event.preventDefault();
                  return;
                }
                onNewChat();
              }}
              onKeyDown={(event) => guardUnavailableKey(event, newChatUnavailable)}
            >
              {creatingChat ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <SquarePen className="size-4" aria-hidden="true" />
              )}
            </button>
          )}
        </RailEntry>

        <RailEntry description={paneHidden ? "Show chats and folders" : "Current workspace: Chats"}>
          {(tooltipId) => (
            <button
              ref={chatsRef}
              className={actionClass({ current: true })}
              type="button"
              aria-current="page"
              aria-describedby={tooltipId}
              aria-label="Chats"
              data-desktop-navigation-control="chats"
              data-testid="workspace-icon-chats"
              title="Chats"
              onClick={() => {
                if (paneHidden) {
                  onRestoreChats();
                }
              }}
            >
              <MessageSquareText className="size-4" aria-hidden="true" />
            </button>
          )}
        </RailEntry>

        <div className="my-1 h-px w-7 bg-trace-subtle" aria-hidden="true" />

        <RailEntry description="Browse and manage assistants">
          {(tooltipId) => (
            <button
              ref={assistantsRef}
              className={actionClass({ unavailable: signingOut })}
              type="button"
              aria-disabled={signingOut || undefined}
              aria-describedby={tooltipId}
              aria-label="Assistants"
              data-desktop-navigation-control="assistants"
              title="Assistants"
              onClick={(event) => {
                if (signingOut) {
                  event.preventDefault();
                  return;
                }
                onOpenAssistants();
              }}
              onKeyDown={(event) => guardUnavailableKey(event, signingOut)}
            >
              <ScrollText className="size-4" aria-hidden="true" />
            </button>
          )}
        </RailEntry>

        <RailEntry description="Open personal settings">
          {(tooltipId) => (
            <button
              ref={settingsRef}
              className={actionClass({ unavailable: signingOut })}
              type="button"
              aria-disabled={signingOut || undefined}
              aria-describedby={tooltipId}
              aria-label="Settings"
              data-desktop-navigation-control="settings"
              title="Settings"
              onClick={(event) => {
                if (signingOut) {
                  event.preventDefault();
                  return;
                }
                onOpenSettings();
              }}
              onKeyDown={(event) => guardUnavailableKey(event, signingOut)}
            >
              <Settings className="size-4" aria-hidden="true" />
            </button>
          )}
        </RailEntry>

        {adminHref ? (
          <RailEntry description="Open installation controls">
            {(tooltipId) => (
              <a
                ref={controlCenterRef}
                className={actionClass({ unavailable: signingOut })}
                href={adminHref}
                aria-disabled={signingOut || undefined}
                aria-describedby={tooltipId}
                aria-label="Control Center"
                data-desktop-navigation-control="control-center"
                title="Control Center"
                onClick={(event) => {
                  if (signingOut) {
                    event.preventDefault();
                  }
                }}
                onKeyDown={(event) => guardUnavailableKey(event, signingOut)}
              >
                <Shield className="size-4" aria-hidden="true" />
              </a>
            )}
          </RailEntry>
        ) : null}
      </div>

      <div className="flex w-12 shrink-0 justify-center">
        <RailEntry description="Open account and session actions">{accountTrigger}</RailEntry>
      </div>
    </nav>
  );
}
