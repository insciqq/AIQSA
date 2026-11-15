"use client";

import { useEventCallback } from "@/components/app-shell/useEventCallback";
import { SectionHeading } from "@/features/library-v2/LibraryV2";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ConnectAddComputer } from "./ConnectAddComputer";
import { listConnectComputers } from "./connectApi";
import {
  ConnectComputersContext,
  type ConnectComputerSource,
  type ConnectComputersContextValue
} from "./connectComputersContext";
import { ConnectComputerFeed, type ConnectLeaveReason } from "./connectDeviceFeed";
import { ConnectComputerList } from "./ConnectDeviceList";

export type ConnectComputersSectionProps = Readonly<{
  /** The origin the install commands name; null when the server does not know a usable one. */
  installOrigin: string | null;
  /** An administrator turned AIQSA Connect off while the section was open. */
  onDisabled(): void;
  /** Fixtures and tests pass a fixed list; otherwise the section opens the live feed. */
  source?: ConnectComputerSource;
}>;

/**
 * Settings › Computers: the user's computers, live while the section is
 * mounted, then how to add one (what `/connect` showed before 2026-11-16).
 * The feed starts on mount and stops on unmount. A turned-off feature calls
 * `onDisabled`; an ended sign-in is the chat shell's to handle, so the section
 * only lets one list request reach the shell's session check.
 */
export function ConnectComputersSection({ installOrigin, onDisabled, source: provided }: ConnectComputersSectionProps) {
  const mounted = useRef(false);
  /** The feed stopped itself: `feed` is the one that stopped. */
  const leave = useEventCallback((reason: ConnectLeaveReason, feed: ConnectComputerSource) => {
    if (reason === "disabled") {
      onDisabled();
      return;
    }
    // The stream ended with "signed out". A request through `shellFetch`
    // tells the chat shell if that is so; otherwise the list resumes.
    void listConnectComputers().then((result) => {
      if (!mounted.current || (!result.ok && result.code === "connect_unauthorized")) return;
      if (!result.ok && result.code === "connect_disabled") onDisabled();
      else feed.start();
    });
  });
  const [ownSource] = useState<ConnectComputerSource | null>(() => {
    if (provided) return null;
    const feed: ConnectComputerFeed = new ConnectComputerFeed({ onLeave: (reason) => leave(reason, feed) });
    return feed;
  });
  const source = provided ?? ownSource!;
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  useEffect(() => {
    mounted.current = true;
    source.start();
    return () => {
      mounted.current = false;
      source.stop();
    };
  }, [source]);

  const value = useMemo<ConnectComputersContextValue>(() => ({ installOrigin, snapshot, source }),
    [installOrigin, snapshot, source]);
  const empty = snapshot.computers?.length === 0;
  return (
    <ConnectComputersContext.Provider value={value}>
      <div className="v2-settings-page" data-testid="settings-computers-panel">
        <SectionHeading description="Through AIQSA Connect, the AIQSA agent can work on your own computers.">
          Computers
        </SectionHeading>
        <div className="v2-connect-section-body">
          <section aria-labelledby="connect-computers-heading" className="flex min-w-0 flex-col gap-3" data-testid="connect-computers">
            <div>
              <h3 className="text-base font-semibold text-ink" id="connect-computers-heading">Your computers</h3>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-secondary">
                {empty
                  ? "Connect a computer so the AIQSA agent can work with your files and run commands there."
                  : "In a chat, choose one with + → Use a computer. Only you can use your computers."}
              </p>
            </div>
            <ConnectComputerList />
          </section>
          <ConnectAddComputer installOrigin={installOrigin} />
        </div>
      </div>
    </ConnectComputersContext.Provider>
  );
}
