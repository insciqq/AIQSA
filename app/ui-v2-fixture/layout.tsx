"use client";

import { useSyncExternalStore, type ReactNode } from "react";

const subscribeToClient = () => () => undefined;

export default function UiV2FixtureLayout({ children }: Readonly<{ children: ReactNode }>) {
  const hydrated = useSyncExternalStore(subscribeToClient, () => true, () => false);

  return (
    <div
      data-hydrated={hydrated ? "true" : "false"}
      data-testid="ui-v2-fixture-hydration"
      style={{ display: hydrated ? "contents" : "none" }}
    >
      {children}
    </div>
  );
}
