"use client";

import { sessionExpiredLoginHref, subscribeToSessionExpired } from "@/components/app-shell/shellApi";
import { UiV2Icon, UiV2IconSprite } from "@/components/ui-v2";
import { AccountMenuV2 } from "@/features/navigation-v2/AccountMenuV2";
import { chatReturnPath } from "@/lib/domain/chatRoute";
import { CONNECT_SETTINGS_PATH } from "@/lib/contracts/connect";
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import type { ConnectLeaveReason } from "./connectDeviceFeed";

/**
 * Chats is another shell with its own layout, so leaving is a full-document
 * navigation, as from Control Center.
 */
export const CONNECT_CHATS_HREF = chatReturnPath(null);

/** Leaves the page: a disabled feature returns to Chats, an ended sign-in signs in again here. */
function leaveConnect(reason: ConnectLeaveReason): void {
  if (reason === "disabled") window.location.assign(CONNECT_CHATS_HREF);
  else window.location.assign(sessionExpiredLoginHref(`${window.location.pathname}${window.location.search}`));
}

/** Opens Settings in the chat shell, at Computers: the place this page belongs to. */
function openConnectSettings(): void {
  window.location.assign(CONNECT_SETTINGS_PATH);
}

type ConnectAccount = Readonly<{ accountId: string; accountLabel: string; adminEntryVisible: boolean }>;

/** The account the shell belongs to, for the header's account menu. */
const ConnectAccountContext = createContext<ConnectAccount | null>(null);

/** How a page under the shell leaves when AIQSA Connect is off or the sign-in ended. */
export const ConnectLeaveContext = createContext<((reason: ConnectLeaveReason) => void) | null>(null);

export function useConnectLeave(): (reason: ConnectLeaveReason) => void {
  const leave = useContext(ConnectLeaveContext);
  if (!leave) throw new Error("useConnectLeave must be used inside ConnectShell");
  return leave;
}

export type ConnectShellProps = Readonly<{
  accountId: string;
  accountLabel: string;
  adminEntryVisible: boolean;
  children: ReactNode;
  /** Fixtures stay on the page. */
  onLeave?(reason: ConnectLeaveReason): void;
}>;

/**
 * The standalone page for approving a computer (`/connect/pair`): no
 * navigation of the chat shell, only the page with its slim header. The
 * user's computers live in Settings › Computers.
 */
export function ConnectShell({ accountId, accountLabel, adminEntryVisible, children, onLeave = leaveConnect }: ConnectShellProps) {
  useEffect(() => subscribeToSessionExpired(() => onLeave("signed_out")), [onLeave]);
  const account = useMemo(() => ({ accountId, accountLabel, adminEntryVisible }), [accountId, accountLabel, adminEntryVisible]);

  return (
    <ConnectLeaveContext.Provider value={onLeave}>
      <ConnectAccountContext.Provider value={account}>
        <div className="v2-connect-shell flex h-[100dvh] min-w-0 flex-col overflow-hidden bg-app-canvas text-ink" data-testid="connect-shell">
          <UiV2IconSprite />
          <main className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="connect-main">
            {children}
          </main>
        </div>
      </ConnectAccountContext.Provider>
    </ConnectLeaveContext.Provider>
  );
}

/** A page's header at every width: the way back to Chats, the title and the account menu. */
export function ConnectPageHeader({ children, title }: Readonly<{ children?: ReactNode; title: ReactNode }>) {
  const account = useContext(ConnectAccountContext);
  return (
    <header className="v2-connect-page-header flex h-12 shrink-0 items-center gap-2 border-b border-trace-subtle px-3 sm:px-4" data-testid="connect-page-header">
      <a aria-label="Chats" className="v2-connect-header-back v2-focusable" href={CONNECT_CHATS_HREF}>
        <UiV2Icon name="arrow-left" />
        <span>Chats</span>
      </a>
      <h1 className="min-w-0 flex-1 truncate text-center text-sm font-semibold text-ink">{title}</h1>
      {children}
      {account ? (
        <AccountMenuV2
          accountId={account.accountId}
          accountLabel={account.accountLabel}
          adminEntryVisible={account.adminEntryVisible}
          onSettings={openConnectSettings}
          variant="avatar"
        />
      ) : null}
    </header>
  );
}
