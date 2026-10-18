"use client";

import { ConnectHomeView } from "@/features/connect/ConnectHomeView";
import { ConnectPairView } from "@/features/connect/ConnectPairView";
import { ConnectSessionView } from "@/features/connect/ConnectSessionView";
import { ConnectShell } from "@/features/connect/ConnectShell";
import { useMemo } from "react";
import {
  connectFixtureDevices,
  installConnectFixtureApi,
  staticConnectDeviceSource,
  staticConnectViewTransport
} from "./connectFixtureApi";

export type ConnectGalleryStateV2 = "empty" | "list" | "pair" | "pair-expired" | "session";

const noop = () => undefined;

/** AIQSA Connect states over synthetic data, for screenshots without a backend. */
export function ConnectV2Gallery({ state }: Readonly<{ state: ConnectGalleryStateV2 }>) {
  const source = useMemo(() => staticConnectDeviceSource(state === "empty" ? [] : connectFixtureDevices()), [state]);
  const transport = useMemo(() => staticConnectViewTransport(), []);
  // Before the pages' own effects read the synthetic API.
  installConnectFixtureApi();
  const devices = source.getSnapshot().devices ?? [];
  const sessionDevice = devices[0];
  return (
    <ConnectShell
      accountId="fixture-account"
      accountLabel="Dana Example"
      adminEntryVisible
      browserNotificationsEnabled={state === "list"}
      installOrigin="https://ai.example.com"
      onLeave={noop}
      source={source}
    >
      {state === "session" && sessionDevice?.sessions[0] ? (
        <ConnectSessionView
          deviceId={sessionDevice.id}
          sessionId={sessionDevice.sessions[0].id}
          transport={transport}
        />
      ) : state === "pair" ? (
        <ConnectPairView code="bcdf2345" />
      ) : state === "pair-expired" ? (
        <ConnectPairView code="ZZZZ-ZZZZ" />
      ) : (
        <ConnectHomeView />
      )}
    </ConnectShell>
  );
}
