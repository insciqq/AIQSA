"use client";

import { sessionExpiredLoginHref, subscribeToSessionExpired } from "@/components/app-shell/shellApi";
import { UiV2Icon, UiV2IconSprite } from "@/components/ui-v2";
import { AccountMenuV2 } from "@/features/navigation-v2/AccountMenuV2";
import { chatReturnPath } from "@/lib/domain/chatRoute";
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { ConnectComputerFeed, type ConnectLeaveReason } from "./connectDeviceFeed";
import { ConnectShellContext, type ConnectComputerSource, type ConnectShellContextValue } from "./connectShellContext";
import { CONNECT_PRODUCT_NAME } from "./connectText";

/**
 * Chats is another shell with its own layout, so leaving is a full-document
 * navigation, as from Control Center.
 */
export const CONNECT_CHATS_HREF = chatReturnPath(null);

/** Leaves the mode: a disabled feature returns to Chats, an ended sign-in signs in again here. */
function leaveConnect(reason: ConnectLeaveReason): void {
  if (reason === "disabled") window.location.assign(CONNECT_CHATS_HREF);
  else window.location.assign(sessionExpiredLoginHref(`${window.location.pathname}${window.location.search}`));
}

type ConnectAccount = Readonly<{ accountId: string; accountLabel: string; adminEntryVisible: boolean }>;

/** The account the shell belongs to, for the phone header's account menu. */
const ConnectAccountContext = createContext<ConnectAccount | null>(null);

export type ConnectShellProps = Readonly<{
  accountId: string;
  accountLabel: string;
  adminEntryVisible: boolean;
  children: ReactNode;
  installOrigin: string | null;
  /** Fixtures pass a fixed list and stay on the page. */
  source?: ConnectComputerSource;
  onLeave?(reason: ConnectLeaveReason): void;
}>;

/**
 * The AIQSA Connect mode: its own rail (Chats returns to the chat shell) and
 * the page. The computer list stays live while pages change inside the mode.
 */
export function ConnectShell({
  accountId,
  accountLabel,
  adminEntryVisible,
  children,
  installOrigin,
  onLeave = leaveConnect,
  source: providedSource
}: ConnectShellProps) {
  const [ownSource] = useState<ConnectComputerSource | null>(() =>
    providedSource ? null : new ConnectComputerFeed({ onLeave: (reason) => onLeave(reason) }));
  const source = providedSource ?? ownSource!;
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  useEffect(() => {
    source.start();
    return () => source.stop();
  }, [source]);
  useEffect(() => subscribeToSessionExpired(() => onLeave("signed_out")), [onLeave]);

  const value = useMemo<ConnectShellContextValue>(() => ({
    installOrigin,
    leave: onLeave,
    snapshot,
    source
  }), [installOrigin, onLeave, snapshot, source]);
  const account = useMemo(() => ({ accountId, accountLabel, adminEntryVisible }), [accountId, accountLabel, adminEntryVisible]);

  return (
    <ConnectShellContext.Provider value={value}>
      <ConnectAccountContext.Provider value={account}>
        <div
          className="v2-connect-shell grid h-[100dvh] min-w-0 grid-cols-[minmax(0,1fr)] overflow-hidden bg-app-canvas text-ink md:grid-cols-[3.5rem_minmax(0,1fr)]"
          data-testid="connect-shell"
        >
          <UiV2IconSprite />
          {/* navigation.css may load after Tailwind, so utilities `.v2-rail` also sets are important. */}
          <nav aria-label="Workspace" className="v2-rail !sticky top-0 max-md:!hidden" data-testid="connect-rail">
            <span aria-hidden="true" className="v2-rail-brand">
              <UiV2Icon name="brand" />
            </span>
            <div className="v2-rail-group">
              <a
                aria-label="Chats"
                className="v2-rail-button v2-focusable"
                data-tooltip="Chats"
                data-tooltip-side="right"
                href={CONNECT_CHATS_HREF}
              >
                <UiV2Icon name="chat" />
              </a>
              <span
                aria-current="page"
                aria-label={CONNECT_PRODUCT_NAME}
                className="v2-rail-button"
                data-tooltip={CONNECT_PRODUCT_NAME}
                data-tooltip-side="right"
                role="link"
              >
                {/* The same glyph as the chat rail's AIQSA Connect entry. */}
                <UiV2Icon name="terminal" />
              </span>
            </div>
            <div className="v2-rail-group v2-rail-bottom">
              {adminEntryVisible ? (
                <a
                  aria-label="Control Center"
                  className="v2-rail-button v2-focusable"
                  data-tooltip="Control Center"
                  data-tooltip-side="right"
                  href="/admin"
                >
                  <UiV2Icon name="shield" />
                </a>
              ) : null}
              <AccountMenuV2 accountId={accountId} accountLabel={accountLabel} variant="avatar" />
            </div>
          </nav>

          <main className="flex min-h-0 min-w-0 flex-col" data-testid="connect-main">
            {children}
          </main>
        </div>
      </ConnectAccountContext.Provider>
    </ConnectShellContext.Provider>
  );
}

/**
 * A page's header. Below the rail's breakpoint it also carries the way back
 * to Chats and the account menu, which the rail holds on wider screens.
 */
export function ConnectPageHeader({ children, title }: Readonly<{ children?: ReactNode; title: ReactNode }>) {
  const account = useContext(ConnectAccountContext);
  return (
    <header className="v2-connect-page-header flex h-12 shrink-0 items-center gap-2 border-b border-trace-subtle px-3 sm:px-4" data-testid="connect-page-header">
      <a aria-label="Chats" className="v2-connect-header-back v2-focusable md:hidden" href={CONNECT_CHATS_HREF}>
        <UiV2Icon name="arrow-left" />
        <span>Chats</span>
      </a>
      <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink max-md:text-center">{title}</h1>
      {children}
      {account ? (
        <span className="md:hidden">
          <AccountMenuV2
            accountId={account.accountId}
            accountLabel={account.accountLabel}
            adminEntryVisible={account.adminEntryVisible}
            variant="avatar"
          />
        </span>
      ) : null}
    </header>
  );
}
