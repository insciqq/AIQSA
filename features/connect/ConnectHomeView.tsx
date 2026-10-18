"use client";

import { UiV2Button } from "@/components/ui-v2";
import { ConnectDeviceList } from "./ConnectDeviceList";
import { ConnectEmptyState } from "./ConnectEmptyState";
import { ConnectDrawerButton, useConnectShell } from "./connectShellContext";
import { CONNECT_PRODUCT_NAME } from "./connectText";

export function ConnectPageHeader({ children, title }: Readonly<{ children?: React.ReactNode; title: React.ReactNode }>) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-trace-subtle px-3 sm:px-4" data-testid="connect-page-header">
      <ConnectDrawerButton />
      <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{title}</h1>
      {children}
    </header>
  );
}

/** `/connect`: install steps without computers, otherwise the way into a session. */
export function ConnectHomeView() {
  const { installOrigin, openNewSession, snapshot } = useConnectShell();
  const devices = snapshot.devices;
  const anyOnline = devices?.some((device) => device.online) ?? false;
  return (
    <>
      <ConnectPageHeader title={CONNECT_PRODUCT_NAME} />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8" data-testid="connect-home">
        {devices === null ? (
          <p className="text-sm text-ink-muted" role="status">
            {snapshot.loadError ? "Your computers could not be loaded yet. Retrying automatically." : "Loading your computers…"}
          </p>
        ) : devices.length === 0 ? (
          <ConnectEmptyState installOrigin={installOrigin} />
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-6">
            <section className="max-lg:hidden" data-testid="connect-home-placeholder">
              <h2 className="text-lg font-semibold text-ink">Open a session</h2>
              <p className="mt-2 text-sm leading-6 text-ink-secondary">
                Choose a session on the left to open its terminal, or start a new one on an online computer.
                Sessions keep running on the computer when you close this page.
              </p>
            </section>
            <div>
              <UiV2Button
                disabled={!anyOnline}
                icon="plus"
                onClick={() => openNewSession()}
                tone="primary"
              >
                New session
              </UiV2Button>
              {anyOnline ? null : (
                <p className="mt-2 text-metadata text-ink-muted">
                  No computer is online. Start aiqsa-connect on one, or check its service.
                </p>
              )}
            </div>
            <div className="lg:hidden">
              <ConnectDeviceList />
            </div>
          </div>
        )}
      </div>
    </>
  );
}
