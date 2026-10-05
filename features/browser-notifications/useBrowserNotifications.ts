"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { BrowserNotificationsView } from "@/components/app-shell/powerAppShellV2Contracts";
import {
  browserPushEnvironment,
  isAppleMobileBrowser,
  notificationPermission,
  removeBrowserPushSubscription,
  syncBrowserPushSubscription,
  type BrowserNotificationPermission,
  type BrowserPushEnvironment
} from "./browserNotificationsClient";
import { useShownRunReports } from "./useShownRunReports";

const BANNER_DISMISSED_KEY = "aiqsa.browserNotifications.bannerDismissed";
/**
 * A shown device rebinds at most this often: another device may have turned
 * push off and on meanwhile, which drops every subscription of the account.
 */
export const BROWSER_PUSH_RESYNC_MS = 10 * 60_000;
/** A refusal right after enabling usually means the setting is still saving. */
export const BROWSER_PUSH_RETRY_MS = 2_000;
const BROWSER_PUSH_DISABLED_RETRIES = 3;

let cachedEnvironment: BrowserPushEnvironment | null | undefined;
function clientEnvironment(): BrowserPushEnvironment | null {
  if (cachedEnvironment === undefined) cachedEnvironment = browserPushEnvironment();
  return cachedEnvironment;
}

function bannerKey(accountId: string): string {
  return `${BANNER_DISMISSED_KEY}:${accountId}`;
}

function readDismissed(accountId: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(bannerKey(accountId)) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(accountId: string): void {
  try {
    window.localStorage.setItem(bannerKey(accountId), "1");
  } catch {
    // A blocked store only means the banner may return on the next visit.
  }
}

const noSubscription = () => () => undefined;

/**
 * Permission can change in the browser's site settings while the app is
 * open: the permission API reports it where available, focus otherwise.
 */
function subscribePermission(environment: BrowserPushEnvironment | null, onChange: () => void): () => void {
  if (!environment?.notification) return () => undefined;
  let status: PermissionStatus | null = null;
  let active = true;
  void navigator.permissions?.query({ name: "notifications" }).then((result) => {
    if (!active) return;
    status = result;
    status.addEventListener("change", onChange);
  }).catch(() => undefined);
  window.addEventListener("focus", onChange);
  document.addEventListener("visibilitychange", onChange);
  return () => {
    active = false;
    status?.removeEventListener("change", onChange);
    window.removeEventListener("focus", onChange);
    document.removeEventListener("visibilitychange", onChange);
  };
}

/**
 * Browser push for the signed-in account on this device: follows the account
 * setting and the browser permission, keeps the device's subscription bound
 * to the current account and offers the one-click permission banner. The
 * browser prompt opens only from `requestPermission`, i.e. from a click.
 */
export function useBrowserNotifications(input: Readonly<{
  accountId: string | null;
  /** The chat on screen, whose answers seen completing here skip this device's push. */
  activeChatId?: string | null;
  /** The account setting; null while it loads. */
  enabled: boolean | null;
  /** Injected in tests; defaults to the real browser. */
  environment?: BrowserPushEnvironment | null;
  setEnabled(value: boolean): void;
}>): BrowserNotificationsView {
  const { accountId, enabled } = input;
  const injected = input.environment;
  const environment = useSyncExternalStore(noSubscription,
    () => injected === undefined ? clientEnvironment() : injected, () => null);
  const [, setPermissionRevision] = useState(0);
  const subscribe = useCallback((onChange: () => void) => subscribePermission(environment, onChange), [environment]);
  const permission = useSyncExternalStore<BrowserNotificationPermission>(subscribe,
    () => notificationPermission(environment), () => "unsupported");
  const appleMobile = useSyncExternalStore(noSubscription, isAppleMobileBrowser, () => false);
  const [dismissedAccounts, setDismissedAccounts] = useState<ReadonlySet<string>>(() => new Set());
  const [requesting, setRequesting] = useState(false);
  const synced = useRef<string | null>(null);
  /** When this device last bound its subscription; 0 retries on the next showing. */
  const lastBound = useRef(0);
  const setEnabledRef = useRef(input.setEnabled);
  useEffect(() => {
    setEnabledRef.current = input.setEnabled;
  });

  // Drop the browser subscription once the account turned push off.
  useEffect(() => {
    if (!accountId || enabled === null || !environment) return;
    const key = `${accountId}:${enabled ? "on" : "off"}:${permission}`;
    if (synced.current === key) return;
    synced.current = key;
    if (!enabled) void removeBrowserPushSubscription(environment);
  }, [accountId, enabled, environment, permission]);

  // While push is on and allowed, bind this device to the signed-in account:
  // at once, again when the app is shown after a while, and shortly after a
  // refusal while the enabling setting may still be saving.
  useEffect(() => {
    if (!accountId || enabled !== true || permission !== "granted" || !environment) return;
    let disposed = false;
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const bind = (force: boolean) => {
      if (disposed) return;
      if (!force && (document.visibilityState !== "visible" || Date.now() - lastBound.current < BROWSER_PUSH_RESYNC_MS)) return;
      lastBound.current = Date.now();
      void syncBrowserPushSubscription(environment).then((result) => {
        if (result === "subscribed" || disposed) return;
        lastBound.current = 0;
        if (result === "disabled" && retries < BROWSER_PUSH_DISABLED_RETRIES) {
          retries += 1;
          retryTimer = setTimeout(() => bind(true), BROWSER_PUSH_RETRY_MS * retries);
        }
      });
    };
    const rebind = () => bind(false);
    bind(true);
    document.addEventListener("visibilitychange", rebind);
    window.addEventListener("focus", rebind);
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", rebind);
      window.removeEventListener("focus", rebind);
    };
  }, [accountId, enabled, environment, permission]);

  useShownRunReports({
    active: Boolean(accountId) && enabled === true && permission === "granted",
    chatId: input.activeChatId ?? null,
    environment
  });

  const dismissed = !accountId || dismissedAccounts.has(accountId) || readDismissed(accountId);
  return {
    appleMobile,
    bannerVisible: enabled === true && permission === "default" && !dismissed,
    dismissBanner() {
      if (!accountId) return;
      writeDismissed(accountId);
      setDismissedAccounts((current) => new Set(current).add(accountId));
    },
    enabled: enabled ?? false,
    permission,
    ready: enabled !== null,
    requestPermission() {
      const notification = environment?.notification;
      if (!notification || requesting || notification.permission !== "default") return;
      setRequesting(true);
      void notification.requestPermission()
        .catch(() => undefined)
        .finally(() => {
          setRequesting(false);
          // The permission snapshot is reread on this render.
          setPermissionRevision((revision) => revision + 1);
        });
    },
    requesting,
    toggle() {
      if (enabled === null) return;
      setEnabledRef.current(!enabled);
    }
  };
}
