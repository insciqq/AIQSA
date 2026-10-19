import { logEvent, runInBackground } from "../../observability";
import { databaseFailureCode } from "../../observability/databaseFailure";
import type { TelegramDefaults } from "../defaultTelegram";
import { telegramHandlerRegistry } from "../dispatcher";
import { createTelegramMediaHandler, lazyTelegramMediaServices } from "../media";
import { lazyTelegramRunGateway } from "./gateway";
import { createTelegramChatBridge, type TelegramChatBridge } from "./index";

/**
 * The application's one chat bridge (one replica), shared across route
 * bundles through `globalThis` like the handler registry it fills. Its AIQSA
 * side (run admission, follow-ups, Stop, reads) loads on the first message,
 * so starting the bot never loads the run stack. Deliveries a restart
 * interrupted are recovered once, right after start.
 */

type TelegramBridgeDefaults = Pick<TelegramDefaults, "access" | "links" | "messageRefs" | "runLinks" | "sessions">;
type RunningBridge = Readonly<{ bridge: TelegramChatBridge; owner: TelegramBridgeDefaults; unregister: () => void }>;

const globalForBridge = globalThis as unknown as { __aiqsaTelegramChatBridge?: RunningBridge };

export function startTelegramChatBridge(telegram: TelegramBridgeDefaults): TelegramChatBridge {
  const running = globalForBridge.__aiqsaTelegramChatBridge;
  if (running?.owner === telegram) return running.bridge;
  // Services rebuilt in this process (a reload): the old bridge's handlers leave with them.
  running?.unregister();
  const bridge = createTelegramChatBridge({
    access: telegram.access,
    gateway: lazyTelegramRunGateway(async () => (await import("./defaultGateway")).createDefaultTelegramRunGateway({ access: telegram.access })),
    links: telegram.links,
    messageRefs: telegram.messageRefs,
    runLinks: telegram.runLinks,
    sessions: telegram.sessions
  });
  // Media after the bridge: the bridge's handler passes voice, audio, photos and documents on.
  const media = createTelegramMediaHandler({
    conversation: bridge.conversation,
    services: lazyTelegramMediaServices(async () => (await import("../media/defaultServices")).createDefaultTelegramMediaServices({
      access: telegram.access
    }))
  });
  const registry = telegramHandlerRegistry();
  const removers = [bridge.register(registry), registry.registerMessage(media)];
  globalForBridge.__aiqsaTelegramChatBridge = {
    bridge, owner: telegram, unregister: () => { for (const remove of removers) remove(); }
  };
  const startedAt = new Date();
  void runInBackground(() => bridge.recover(startedAt)).catch((error: unknown) => logEvent("service_operation", {
    code: "telegram_run_recovery_failed", error, outcome: "failed", prisma_code: databaseFailureCode(error), stage: "recovery",
    subsystem: "telegram"
  }));
  return bridge;
}

/** The running bridge, for features that start runs or add content to a chat (approvals, media); null before start. */
export function telegramChatBridge(): TelegramChatBridge | null {
  return globalForBridge.__aiqsaTelegramChatBridge?.bridge ?? null;
}
