"use client";

import { ConnectComputerFeed, type ConnectComputerFeedSnapshot } from "@/features/connect/connectDeviceFeed";
import type { ConnectComputerSource } from "@/features/connect/connectShellContext";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

export type ComposerComputersV2 = ConnectComputerFeedSnapshot & Readonly<{
  /** An administrator turned AIQSA Connect off since the page loaded. */
  disabled: boolean;
}>;

const IDLE: ConnectComputerFeedSnapshot = { computers: null, connection: "connecting", loadError: null };
const idleSource: ConnectComputerSource = {
  getSnapshot: () => IDLE,
  removeComputer: () => undefined,
  start: () => undefined,
  stop: () => undefined,
  subscribe: () => () => undefined
};

/**
 * The user's computers for the composer's chip and picker, live through the
 * same `/api/connect/events` feed as `/connect`. The stream is open only while
 * `active` (a computer is chosen or the picker is open). Fixtures and tests
 * pass a fixed `source`.
 */
export function useComposerComputers(active: boolean, provided?: ConnectComputerSource): ComposerComputersV2 {
  const [disabled, setDisabled] = useState(false);
  const feed = useMemo(() => provided || !active ? null : new ConnectComputerFeed({
    // Signing out is the shell's to handle; a turned-off feature leaves the chip unavailable.
    onLeave: (reason) => {
      if (reason === "disabled") setDisabled(true);
    }
  }), [active, provided]);
  const source = provided ?? feed ?? idleSource;

  useEffect(() => {
    source.start();
    return () => source.stop();
  }, [source]);

  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  return useMemo(() => ({ ...snapshot, disabled }), [disabled, snapshot]);
}
