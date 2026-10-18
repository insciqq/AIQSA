"use client";

import { UiV2IconButton } from "@/components/ui-v2";
import type { ConnectDevice } from "@/lib/contracts/connect";
import { createContext, useContext } from "react";
import type { ConnectDeviceFeed, ConnectDeviceFeedSnapshot, ConnectLeaveReason } from "./connectDeviceFeed";

/** The device list a shell renders: the live feed, or a fixed one in fixtures. */
export type ConnectDeviceSource = Pick<
  ConnectDeviceFeed,
  "getSnapshot" | "removeDevice" | "removeSession" | "start" | "stop" | "subscribe"
>;

export type ConnectShellContextValue = Readonly<{
  /** Where the install commands point: this installation's canonical origin. */
  installOrigin: string | null;
  leave(reason: ConnectLeaveReason): void;
  openDrawer(): void;
  openNewSession(deviceId?: string): void;
  snapshot: ConnectDeviceFeedSnapshot;
  source: ConnectDeviceSource;
}>;

export const ConnectShellContext = createContext<ConnectShellContextValue | null>(null);

export function useConnectShell(): ConnectShellContextValue {
  const value = useContext(ConnectShellContext);
  if (!value) throw new Error("useConnectShell must be used inside ConnectShell");
  return value;
}

export function findConnectDevice(snapshot: ConnectDeviceFeedSnapshot, deviceId: string): ConnectDevice | null {
  return snapshot.devices?.find((device) => device.id === deviceId) ?? null;
}

/** The narrow-screen opener of the machine column, for a page header. */
export function ConnectDrawerButton() {
  const { openDrawer } = useConnectShell();
  return <UiV2IconButton className="lg:hidden" icon="menu" label="Machines and sessions" onClick={openDrawer} />;
}
