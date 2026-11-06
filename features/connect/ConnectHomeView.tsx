"use client";

import { ConnectAddComputer } from "./ConnectAddComputer";
import { ConnectComputerList } from "./ConnectDeviceList";
import { ConnectPageHeader } from "./ConnectShell";
import { useConnectShell } from "./connectShellContext";
import { CONNECT_PRODUCT_NAME } from "./connectText";

/** `/connect`: the user's computers, then how to add one (D-20). */
export function ConnectHomeView() {
  const { installOrigin, snapshot } = useConnectShell();
  const empty = snapshot.computers?.length === 0;
  return (
    <>
      <ConnectPageHeader title={CONNECT_PRODUCT_NAME} />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8" data-testid="connect-home">
        <div className="v2-connect-page">
          <section aria-labelledby="connect-computers-heading" className="flex min-w-0 flex-col gap-3">
            <div>
              <h2 className="text-base font-semibold text-ink" id="connect-computers-heading">Your computers</h2>
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
    </>
  );
}
