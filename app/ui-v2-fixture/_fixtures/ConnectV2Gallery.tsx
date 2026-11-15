"use client";

import { UiV2IconSprite } from "@/components/ui-v2";
import { ConnectComputersSection } from "@/features/connect/ConnectComputersSection";
import { ConnectPairView } from "@/features/connect/ConnectPairView";
import { ConnectShell } from "@/features/connect/ConnectShell";
import { useMemo } from "react";
import { connectFixtureComputers, installConnectFixtureApi, staticConnectComputerSource } from "./connectFixtureApi";

export type ConnectGalleryStateV2 = "empty" | "empty-ipv6" | "list" | "pair" | "pair-expired";

const noop = () => undefined;

/**
 * AIQSA Connect states over synthetic data, for screenshots without a
 * backend: Settings › Computers in a Settings content pane, and the pair page
 * in its own shell.
 */
export function ConnectV2Gallery({ state }: Readonly<{ state: ConnectGalleryStateV2 }>) {
  const empty = state === "empty" || state === "empty-ipv6";
  const source = useMemo(() => staticConnectComputerSource(empty ? [] : connectFixtureComputers()), [empty]);
  // Before the pages' own effects read the synthetic API.
  installConnectFixtureApi();
  if (state === "pair" || state === "pair-expired") {
    return (
      <ConnectShell accountId="fixture-account" accountLabel="Dana Example" adminEntryVisible onLeave={noop}>
        <ConnectPairView code={state === "pair" ? "bcdf2345" : "ZZZZ-ZZZZ"} />
      </ConnectShell>
    );
  }
  return (
    <div className="flex h-[100dvh] min-w-0 flex-col bg-app-canvas text-ink">
      <UiV2IconSprite />
      <section className="v2-library-panel min-h-0 flex-1" data-library-tab="computers">
        <div className="v2-library-content">
          <ConnectComputersSection
            installOrigin={state === "empty-ipv6" ? "https://[2001:db8::20]:8443" : "https://ai.example.com"}
            onDisabled={noop}
            source={source}
          />
        </div>
      </section>
    </div>
  );
}
