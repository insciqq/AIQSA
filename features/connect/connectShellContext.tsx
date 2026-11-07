"use client";

import { createContext, useContext } from "react";
import type { ConnectComputerFeed, ConnectComputerFeedSnapshot, ConnectLeaveReason } from "./connectDeviceFeed";

/** The computer list a shell renders: the live feed, or a fixed one in fixtures. */
export type ConnectComputerSource = Pick<ConnectComputerFeed, "getSnapshot" | "removeComputer" | "start" | "stop" | "subscribe">;

export type ConnectShellContextValue = Readonly<{
  /** Where the install commands and downloads point: this installation's canonical origin. */
  installOrigin: string | null;
  leave(reason: ConnectLeaveReason): void;
  snapshot: ConnectComputerFeedSnapshot;
  source: ConnectComputerSource;
}>;

export const ConnectShellContext = createContext<ConnectShellContextValue | null>(null);

export function useConnectShell(): ConnectShellContextValue {
  const value = useContext(ConnectShellContext);
  if (!value) throw new Error("useConnectShell must be used inside ConnectShell");
  return value;
}
