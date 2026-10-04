"use client";

import type { BrowserNotificationsView } from "@/components/app-shell/powerAppShellV2Contracts";
import { UiV2Button, UiV2Icon, UiV2IconButton } from "@/components/ui-v2";
import { SettingsRowV2, SettingsSwitchV2 } from "@/features/settings-v2/SettingsV2";

function permissionCopy(notifications: BrowserNotificationsView): string {
  if (!notifications.enabled) return "Get a notification when an answer or a scheduled task finishes while AIQSA is in the background or closed.";
  switch (notifications.permission) {
    case "granted": return "This device shows a notification when an answer or a scheduled task finishes while AIQSA is in the background or closed.";
    case "denied": return "Notifications are blocked for this site. Allow them in your browser’s site settings, then reload AIQSA.";
    case "default": return "Allow notifications in this browser to receive them on this device.";
    default: return notifications.appleMobile
      ? "On iPhone and iPad, add AIQSA to the Home Screen and open it from there to receive notifications."
      : "This browser does not support notifications.";
  }
}

/** Settings → General row: the account setting and this device's permission state. */
export function BrowserNotificationsSettingsRowV2({ notifications }: Readonly<{ notifications: BrowserNotificationsView }>) {
  return (
    <SettingsRowV2
      description={<span data-testid="browser-notifications-status">{permissionCopy(notifications)}</span>}
      testId="settings-browser-notifications"
      title="Browser notifications"
    >
      <SettingsSwitchV2
        checked={notifications.enabled}
        disabled={!notifications.ready}
        label="Browser notifications"
        onChange={() => notifications.toggle()}
      />
      {notifications.enabled && notifications.permission === "default" ? (
        <UiV2Button disabled={notifications.requesting} onClick={() => notifications.requestPermission()}>
          Allow notifications
        </UiV2Button>
      ) : null}
    </SettingsRowV2>
  );
}

/**
 * The one-click request for browser permission. Browsers open their prompt
 * only from a user gesture, so nothing asks until the button is clicked.
 */
export function BrowserNotificationsBannerV2({ notifications }: Readonly<{ notifications: BrowserNotificationsView }>) {
  if (!notifications.bannerVisible) return null;
  return (
    <div className="v2-live-notice">
      <div aria-label="Browser notifications" className="v2-notice" data-kind="info" data-testid="browser-notifications-banner" role="region">
        <UiV2Icon className="v2-notice-icon" name="bell" />
        <div className="v2-notice-body">
          <span className="v2-notice-text">Get notified when answers and scheduled tasks finish, even with AIQSA closed.</span>
          <span className="v2-notice-actions">
            <UiV2Button
              className="v2-notice-action"
              disabled={notifications.requesting}
              tone="ghost"
              onClick={() => notifications.requestPermission()}
            >
              Allow notifications
            </UiV2Button>
          </span>
        </div>
        <UiV2IconButton
          className="v2-notice-close"
          icon="close"
          label="Dismiss notifications banner"
          onClick={() => notifications.dismissBanner()}
        />
      </div>
    </div>
  );
}
