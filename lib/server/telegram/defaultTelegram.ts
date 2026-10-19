import { getAuthConfig } from "../auth/config";
import { createPrismaLoginRateLimiter } from "../auth/prismaRateLimit";
import { logEvent } from "../observability";
import { prisma } from "../prisma";
import { getSecretEncryptionKey } from "../secrets/envelope";
import { createTelegramBotApi } from "./botApi";
import {
  createPrismaTelegramAccessUserSource, createTelegramAccessResolver, type TelegramAccessResolver
} from "./control/access";
import { telegramControlHooks } from "./control/hooks";
import { createPrismaTelegramControlRepository } from "./control/repository";
import { createTelegramControlService, type TelegramControlService } from "./control/service";
import { createTelegramSessionProvider, type TelegramSessionProvider } from "./control/session";
import { createTelegramControlCache, effectiveTelegramControl, type TelegramEffectiveControl } from "./control/state";
import { TELEGRAM_COPY } from "./copy";
import { createTelegramDispatcher, telegramHandlerRegistry, type TelegramDispatcher } from "./dispatcher";
import { createTelegramLinkCommands } from "./linking/commands";
import { createPrismaTelegramLinkingRepository } from "./linking/repository";
import {
  createTelegramLinkingService, TELEGRAM_LINK_CODE_RATE_LIMIT, TELEGRAM_LINK_CODE_RATE_WINDOW_MS, type TelegramLinkingService
} from "./linking/service";
import { createTelegramOutbound } from "./outbound";
import { createTelegramPoller, type TelegramPoller } from "./poller";
import { createPrismaTelegramCallbackStore, type TelegramCallbackStore } from "./store/callbacks";
import { createPrismaTelegramLinkStore, type TelegramLinkStore } from "./store/links";
import { createPrismaTelegramMessageRefStore, type TelegramMessageRefStore } from "./store/messageRefs";
import { createPrismaTelegramReceiptStore } from "./store/receipts";
import { createPrismaTelegramRunLinkStore, type TelegramRunLinkStore } from "./store/runLinks";
import { createTelegramTransport, type TelegramTransport } from "./transport";

/**
 * Telegram Connect for this application process (one replica), shared across
 * route bundles through `globalThis`: the control service and cache, access,
 * linking, stores, the bot session per token generation, the dispatcher and
 * the one poller, started from `instrumentation.ts`.
 */

export type TelegramDefaults = Readonly<{
  access: TelegramAccessResolver;
  callbacks: TelegramCallbackStore;
  control(): Promise<TelegramEffectiveControl>;
  controlService: TelegramControlService;
  dispatcher: TelegramDispatcher;
  linking: TelegramLinkingService;
  links: TelegramLinkStore;
  messageRefs: TelegramMessageRefStore;
  poller: TelegramPoller;
  runLinks: TelegramRunLinkStore;
  sessions: TelegramSessionProvider;
}>;

const globalForTelegram = globalThis as unknown as { __aiqsaTelegram?: TelegramDefaults; __aiqsaTelegramStarted?: boolean };

function createDefaults(): TelegramDefaults {
  let transport: TelegramTransport | undefined;
  const createApi = (token: string) => createTelegramBotApi({ token, transport: transport ??= createTelegramTransport() });
  const repository = createPrismaTelegramControlRepository(prisma);
  const cache = createTelegramControlCache({ load: async () => effectiveTelegramControl(await repository.read(), getSecretEncryptionKey) });
  const control = () => cache.get();
  const links = createPrismaTelegramLinkStore(prisma);
  const callbacks = createPrismaTelegramCallbackStore(prisma);
  const messageRefs = createPrismaTelegramMessageRefStore(prisma);
  const receipts = createPrismaTelegramReceiptStore(prisma);
  const access = createTelegramAccessResolver({ control, links, users: createPrismaTelegramAccessUserSource(prisma) });
  const appBaseUrl = getAuthConfig().appBaseUrl;
  const sessions = createTelegramSessionProvider({
    control,
    createApi,
    createOutbound: ({ api, botId }) => createTelegramOutbound({ api, appBaseUrl, botId, callbacks, messageRefs })
  });
  const linking = createTelegramLinkingService({
    access,
    control,
    async notifyDisconnected(removed) {
      try {
        const session = await sessions.current();
        if (session?.botId === removed.botId) await session.outbound.sendText({ chatId: removed.telegramChatId, text: TELEGRAM_COPY.disconnected });
      } catch (error) {
        logEvent("service_operation", { code: "telegram_notice_failed", error, outcome: "failed", stage: "dispatch", subsystem: "telegram" });
      }
    },
    rateLimiter: createPrismaLoginRateLimiter({
      keySecret: () => getAuthConfig().sessionSecret,
      maxAttempts: TELEGRAM_LINK_CODE_RATE_LIMIT,
      prisma,
      windowMs: TELEGRAM_LINK_CODE_RATE_WINDOW_MS
    }),
    repository: createPrismaTelegramLinkingRepository(prisma)
  });
  const dispatcher = createTelegramDispatcher({
    access, callbacks, commands: createTelegramLinkCommands({ linking }), links, receipts, registry: telegramHandlerRegistry()
  });
  return Object.freeze({
    access,
    callbacks,
    control,
    controlService: createTelegramControlService({
      cache, createBotApi: createApi, encryptionKey: getSecretEncryptionKey, hooks: telegramControlHooks(), repository
    }),
    dispatcher,
    linking,
    links,
    messageRefs,
    poller: createTelegramPoller({ dispatcher, health: repository, receipts, sessions }),
    runLinks: createPrismaTelegramRunLinkStore(prisma),
    sessions
  });
}

export function getDefaultTelegram(): TelegramDefaults {
  globalForTelegram.__aiqsaTelegram ??= createDefaults();
  return globalForTelegram.__aiqsaTelegram;
}

/** Starts polling when the bot is on and re-evaluates after every administrator change. */
export function startDefaultTelegram(): void {
  const telegram = getDefaultTelegram();
  if (!globalForTelegram.__aiqsaTelegramStarted) {
    globalForTelegram.__aiqsaTelegramStarted = true;
    telegramControlHooks().onChange(() => telegram.poller.reevaluate());
  }
  telegram.poller.reevaluate();
}

/** Route-facing services, built on first use rather than at module load. */
export const defaultTelegramControlService: TelegramControlService = Object.freeze({
  disable: (input) => getDefaultTelegram().controlService.disable(input),
  enable: (input) => getDefaultTelegram().controlService.enable(input),
  read: () => getDefaultTelegram().controlService.read(),
  setAccess: (input) => getDefaultTelegram().controlService.setAccess(input),
  testAndSave: (input) => getDefaultTelegram().controlService.testAndSave(input)
});

export const defaultTelegramLinkingService: TelegramLinkingService = Object.freeze({
  adminUnlink: (userId) => getDefaultTelegram().linking.adminUnlink(userId),
  adminView: (userId) => getDefaultTelegram().linking.adminView(userId),
  createLinkCode: (input) => getDefaultTelegram().linking.createLinkCode(input),
  linkFromStart: (input) => getDefaultTelegram().linking.linkFromStart(input),
  status: (userId) => getDefaultTelegram().linking.status(userId),
  unlink: (userId) => getDefaultTelegram().linking.unlink(userId),
  unlinkFromBot: (input) => getDefaultTelegram().linking.unlinkFromBot(input)
});

/**
 * The viewer flag: true when the bot is on and open to the user, or when the
 * user has a link whose state (connected, access off, bot changed) settings show.
 * A failed read hides the block instead of failing the page.
 */
export async function isTelegramAvailableForUser(userId: string): Promise<boolean> {
  try {
    return (await getDefaultTelegram().access.userStatus(userId)).available;
  } catch (error) {
    logEvent("service_operation", { code: "telegram_control_unavailable", error, outcome: "failed", stage: "read", subsystem: "telegram" });
    return false;
  }
}
