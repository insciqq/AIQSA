"use client";

import { ConnectHomeView } from "@/features/connect/ConnectHomeView";
import { ConnectPairView } from "@/features/connect/ConnectPairView";
import { ConnectShell } from "@/features/connect/ConnectShell";
import { useMemo } from "react";
import { connectFixtureComputers, installConnectFixtureApi, staticConnectComputerSource } from "./connectFixtureApi";

export type ConnectGalleryStateV2 = "empty" | "empty-ipv6" | "list" | "pair" | "pair-expired";

const noop = () => undefined;

/** AIQSA Connect states over synthetic data, for screenshots without a backend. */
export function ConnectV2Gallery({ state }: Readonly<{ state: ConnectGalleryStateV2 }>) {
  const empty = state === "empty" || state === "empty-ipv6";
  const source = useMemo(() => staticConnectComputerSource(empty ? [] : connectFixtureComputers()), [empty]);
  // Before the pages' own effects read the synthetic API.
  installConnectFixtureApi();
  return (
    <ConnectShell
      accountId="fixture-account"
      accountLabel="Dana Example"
      adminEntryVisible
      installOrigin={state === "empty-ipv6" ? "https://[2001:db8::20]:8443" : "https://ai.example.com"}
      onLeave={noop}
      source={source}
    >
      {state === "pair" ? (
        <ConnectPairView code="bcdf2345" />
      ) : state === "pair-expired" ? (
        <ConnectPairView code="ZZZZ-ZZZZ" />
      ) : (
        <ConnectHomeView />
      )}
    </ConnectShell>
  );
}
