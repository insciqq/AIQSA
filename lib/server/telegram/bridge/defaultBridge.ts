import { registerTelegramAgentStatus } from "../agentStatus";
import { registerTelegramApprovals } from "../approvals";
import { telegramControlHooks } from "../control/hooks";
import type { TelegramDefaults } from "../defaultTelegram";
import { telegramHandlerRegistry } from "../dispatcher";
import { registerTelegramRunFiles } from "../files";
import { createTelegramMediaHandler, lazyTelegramMediaServices } from "../media";
import { lazyTelegramRunGateway } from "./gateway";
import { createTelegramChatBridge, type TelegramChatBridge } from "./index";

/**
 * The application's one chat bridge (one replica), shared across route
 * bundles through `globalThis` like the handler registry it fills. Its AIQSA
 * side (run admission, follow-ups, Stop, reads) loads on the first message,
 * so starting the bot never loads the run stack. Deliveries a restart
 * interrupted, or this process stopped following, are swept right after
 * start, once a minute and after every administrator change of the bot (so
 * as soon as it is switched on).
 */

type TelegramBridgeDefaults = Pick<TelegramDefaults, "access" | "links" | "messageRefs" | "runLinks" | "sessions">;
type RunningBridge = Readonly<{ bridge: TelegramChatBridge; owner: TelegramBridgeDefaults; unregister: () => void }>;

const globalForBridge = globalThis as unknown as { __aiqsaTelegramChatBridge?: RunningBridge };

export function startTelegramChatBridge(telegram: TelegramBridgeDefaults): TelegramChatBridge {
  const running = globalForBridge.__aiqsaTelegramChatBridge;
  if (running?.owner === telegram) return running.bridge;
  // Services rebuilt in this process (a reload): the old bridge's handlers leave with them.
  running?.unregister();
  const gateway = lazyTelegramRunGateway(async () => (await import("./defaultGateway")).createDefaultTelegramRunGateway({ access: telegram.access }));
  const bridge = createTelegramChatBridge({
    access: telegram.access,
    gateway,
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
  // Approvals, the Workspace status and answer files follow the bridge's runs and leave with its handlers.
  const removers = [
    bridge.register(registry),
    registry.registerMessage(media),
    registerTelegramApprovals({ access: telegram.access, conversation: bridge.conversation, registry, sessions: telegram.sessions }),
    registerTelegramAgentStatus({
      access: telegram.access, messageRefs: telegram.messageRefs, runLinks: telegram.runLinks, sessions: telegram.sessions
    }),
    registerTelegramRunFiles({ access: telegram.access, answer: (input) => gateway.answer(input) })
  ];
  const unregister = () => {
    for (const remove of removers) remove();
  };
  globalForBridge.__aiqsaTelegramChatBridge = { bridge, owner: telegram, unregister };
  const startedAt = new Date();
  // The sweeps leave with the handlers too.
  removers.push(bridge.startRecovery(startedAt), telegramControlHooks().onChange(() => { void bridge.recover(startedAt); }));
  return bridge;
}

/** The running bridge, for features that start runs or add content to a chat (approvals, media); null before start. */
export function telegramChatBridge(): TelegramChatBridge | null {
  return globalForBridge.__aiqsaTelegramChatBridge?.bridge ?? null;
}
