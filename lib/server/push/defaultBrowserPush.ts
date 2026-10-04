import { getAuthConfig } from "../auth/config";
import { runInBackground } from "../observability";
import { prisma } from "../prisma";
import { getSecretEncryptionKey } from "../secrets/envelope";
import { createPinnedPushPost } from "./pushTransport";
import { registerRunTerminalListener } from "./runTerminalSignal";
import { createBrowserPushSender, type BrowserPushSender } from "./sender";
import { createPrismaBrowserPushStore, type BrowserPushStore } from "./store";
import { createPrismaVapidKeyStore } from "./vapidKeys";
import type { VapidKeyPair } from "./webPushCrypto";

type BrowserPushDefaults = Readonly<{
  keys: () => Promise<VapidKeyPair>;
  sender: BrowserPushSender;
  store: BrowserPushStore;
}>;

const globalForPush = globalThis as unknown as { __aiqsaBrowserPush?: BrowserPushDefaults };

/** One sender, key cache and store per application process (single replica), shared across route bundles. */
export function getDefaultBrowserPush(): BrowserPushDefaults {
  if (!globalForPush.__aiqsaBrowserPush) {
    const store = createPrismaBrowserPushStore(prisma);
    const keys = createPrismaVapidKeyStore(prisma, () => getSecretEncryptionKey());
    const sender = createBrowserPushSender({
      background: (work) => runInBackground(work),
      keys,
      post: createPinnedPushPost(),
      store,
      subject: new URL(getAuthConfig().appBaseUrl).origin
    });
    globalForPush.__aiqsaBrowserPush = { keys, sender, store };
  }
  return globalForPush.__aiqsaBrowserPush;
}

/** Connects committed run terminals to the sender; the scheduled-task runner calls the sender itself. */
export function startDefaultBrowserPush(): void {
  registerRunTerminalListener((runId) => getDefaultBrowserPush().sender.notifyRun(runId));
}
