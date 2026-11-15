"use client";

import { createContext, useContext } from "react";
import type { ConnectComputerFeed, ConnectComputerFeedSnapshot } from "./connectDeviceFeed";

/** The computer list a view renders: the live feed, or a fixed one in fixtures. */
export type ConnectComputerSource = Pick<ConnectComputerFeed, "getSnapshot" | "removeComputer" | "start" | "stop" | "subscribe">;

export type ConnectComputersContextValue = Readonly<{
  /** Where the install commands and downloads point: this installation's canonical origin. */
  installOrigin: string | null;
  snapshot: ConnectComputerFeedSnapshot;
  source: ConnectComputerSource;
}>;

/** What Settings › Computers gives the computer list inside it. */
export const ConnectComputersContext = createContext<ConnectComputersContextValue | null>(null);

export function useConnectComputers(): ConnectComputersContextValue {
  const value = useContext(ConnectComputersContext);
  if (!value) throw new Error("useConnectComputers must be used inside Settings › Computers");
  return value;
}
