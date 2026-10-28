"use client";

import { sessionExpiredLoginHref, subscribeToSessionExpired } from "@/components/app-shell/shellApi";
import { useDialogFocus } from "@/components/app-shell/useDialogFocus";
import { UiV2Icon, UiV2IconButton, UiV2IconSprite } from "@/components/ui-v2";
import { BrowserNotificationsBannerV2 } from "@/features/browser-notifications/BrowserNotificationsV2";
import { useBrowserNotifications } from "@/features/browser-notifications/useBrowserNotifications";
import { AccountMenuV2 } from "@/features/navigation-v2/AccountMenuV2";
import { chatReturnPath } from "@/lib/domain/chatRoute";
import { usePathname } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode
} from "react";
import { ConnectDeviceFeed, type ConnectLeaveReason } from "./connectDeviceFeed";
import { ConnectDeviceList } from "./ConnectDeviceList";
import { ConnectShellContext, type ConnectDeviceSource, type ConnectShellContextValue } from "./connectShellContext";
import { ConnectNewSessionDialog } from "./ConnectNewSessionDialog";
import { CONNECT_PRODUCT_NAME } from "./connectText";

const DRAWER_QUERY = "(max-width: 1023px)";

function subscribeDrawer(onChange: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
  const query = window.matchMedia(DRAWER_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function readDrawer(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia ? window.matchMedia(DRAWER_QUERY).matches : window.innerWidth < 1024;
}

/**
 * Chats is another shell with its own layout, so leaving is a full-document
 * navigation, as from Control Center.
 */
const CHATS_HREF = chatReturnPath(null);

/** Leaves the mode: a disabled feature returns to Chats, an ended sign-in signs in again here. */
function leaveConnect(reason: ConnectLeaveReason): void {
  if (reason === "disabled") window.location.assign(CHATS_HREF);
  else window.location.assign(sessionExpiredLoginHref(`${window.location.pathname}${window.location.search}`));
}

const noop = () => undefined;

export type ConnectShellProps = Readonly<{
  accountId: string;
  accountLabel: string;
  adminEntryVisible: boolean;
  /** The account's browser-notification setting, read by the server page. */
  browserNotificationsEnabled: boolean;
  children: ReactNode;
  installOrigin: string | null;
  /** Fixtures pass a fixed list and stay on the page. */
  source?: ConnectDeviceSource;
  onLeave?(reason: ConnectLeaveReason): void;
}>;

/**
 * The AIQSA Connect mode: its own rail (Chats returns to the chat shell), the
 * machine and session column (a drawer below the desktop breakpoint) and the
 * page. The device list stays live while pages change inside the mode.
 */
export function ConnectShell({
  accountId,
  accountLabel,
  adminEntryVisible,
  browserNotificationsEnabled,
  children,
  installOrigin,
  onLeave = leaveConnect,
  source: providedSource
}: ConnectShellProps) {
  const [ownSource] = useState<ConnectDeviceSource | null>(() =>
    providedSource ? null : new ConnectDeviceFeed({ onLeave: (reason) => onLeave(reason) }));
  const source = providedSource ?? ownSource!;
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  useEffect(() => {
    source.start();
    return () => source.stop();
  }, [source]);
  useEffect(() => subscribeToSessionExpired(() => onLeave("signed_out")), [onLeave]);

  // The push subscription of this device follows the account setting here
  // too, so notifications reach a browser that only ever opened this mode.
  const notifications = useBrowserNotifications({
    accountId,
    enabled: browserNotificationsEnabled,
    setEnabled: noop
  });

  const drawerComposition = useSyncExternalStore(subscribeDrawer, readDrawer, () => false);
  const [drawerRequested, setDrawerRequested] = useState(false);
  const drawerOpen = drawerComposition && drawerRequested;
  const closeDrawer = useCallback(() => setDrawerRequested(false), []);
  const drawerRef = useDialogFocus<HTMLElement>({ active: drawerOpen, onClose: closeDrawer, pointerFocusesDialog: true });
  const pathname = usePathname();
  const [drawerPath, setDrawerPath] = useState(pathname);
  if (drawerPath !== pathname) {
    // A chosen session or page closes the drawer.
    setDrawerPath(pathname);
    setDrawerRequested(false);
  }

  const [newSession, setNewSession] = useState<Readonly<{ deviceId: string | null }> | null>(null);
  const value = useMemo<ConnectShellContextValue>(() => ({
    installOrigin,
    leave: onLeave,
    openDrawer: () => setDrawerRequested(true),
    openNewSession: (deviceId) => {
      setDrawerRequested(false);
      setNewSession({ deviceId: deviceId ?? null });
    },
    snapshot,
    source
  }), [installOrigin, onLeave, snapshot, source]);

  const onlineDevices = snapshot.devices?.filter((device) => device.online) ?? [];

  return (
    <ConnectShellContext.Provider value={value}>
      <div
        className="v2-connect-shell grid h-[100dvh] min-w-0 grid-cols-[minmax(0,1fr)] overflow-hidden bg-app-canvas text-ink md:grid-cols-[3.5rem_minmax(0,1fr)] lg:grid-cols-[3.5rem_18rem_minmax(0,1fr)]"
        data-drawer-open={drawerOpen ? "true" : undefined}
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
              href={CHATS_HREF}
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

        {drawerOpen ? (
          <button
            aria-label="Close machines"
            className="fixed inset-0 z-[29] bg-scrim/70 md:left-14 lg:hidden"
            data-testid="connect-drawer-scrim"
            onClick={closeDrawer}
            type="button"
          />
        ) : null}

        <aside
          aria-label="Machines and sessions"
          aria-modal={drawerOpen ? true : undefined}
          className={[
            "flex min-h-0 min-w-0 flex-col border-r border-trace-subtle bg-workspace-rail outline-none",
            "max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-30 max-lg:w-[min(18rem,calc(100vw-3rem))] max-lg:shadow-overlay md:max-lg:left-14",
            "lg:h-[100dvh]",
            drawerOpen ? "" : "max-lg:hidden"
          ].join(" ")}
          data-testid="connect-column"
          ref={drawerRef}
          role={drawerOpen ? "dialog" : undefined}
        >
          <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-trace-subtle pl-4 pr-2">
            <p className="min-w-0 truncate text-sm font-semibold text-ink">{CONNECT_PRODUCT_NAME}</p>
            <div className="flex shrink-0 items-center gap-1">
              <UiV2IconButton
                disabled={onlineDevices.length === 0}
                icon="plus"
                label="New session"
                onClick={() => value.openNewSession()}
                tooltip={onlineDevices.length === 0 ? "No computer is online" : "New session"}
              />
              {drawerOpen ? <UiV2IconButton icon="close" label="Close machines" onClick={closeDrawer} /> : null}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-3" data-testid="connect-column-scroll">
            <ConnectDeviceList />
          </div>
          <div className="v2-navigation-footer md:!hidden">
            <a className="v2-navigation-destination v2-focusable" href={CHATS_HREF}>
              <UiV2Icon name="chat" />
              Chats
            </a>
            <AccountMenuV2 accountId={accountId} accountLabel={accountLabel} adminEntryVisible={adminEntryVisible} variant="row" />
          </div>
        </aside>

        <main className="flex min-h-0 min-w-0 flex-col" data-testid="connect-main">
          {notifications.bannerVisible ? (
            <div className="shrink-0 pt-3">
              <BrowserNotificationsBannerV2 notifications={notifications} />
            </div>
          ) : null}
          {children}
        </main>
      </div>
      {newSession ? (
        <ConnectNewSessionDialog
          devices={onlineDevices}
          initialDeviceId={newSession.deviceId}
          onClose={() => setNewSession(null)}
        />
      ) : null}
    </ConnectShellContext.Provider>
  );
}
