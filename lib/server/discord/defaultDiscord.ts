import { defaultAssistantRepository } from "../assistants/defaultAssistants";
import { availableAssistantIdentities, isAssistantAvailable } from "../assistants/bindingAccess";
import { createServiceAccount } from "../auth/serviceAccounts";
import { createPrismaCatalogDataLoader } from "../catalog/prismaCatalogData";
import { mcpRepository } from "../mcp/defaultMcp";
import { kickDefaultMcpRuntime } from "../mcp/defaultRuntime";
import { logEvent } from "../observability";
import { prisma } from "../prisma";
import { getSecretEncryptionKey } from "../secrets/envelope";
import { usageLimitsRepository } from "../usageLimits/defaultRepository";
import {
  createDiscordChannelDirectory, createDiscordMembership, discordChannelInfo, type DiscordChannelDirectory, type DiscordChannelInfo
} from "./access";
import { discordControlHooks } from "./control/hooks";
import { createPrismaDiscordControlRepository, type DiscordControlRepository } from "./control/repository";
import {
  createDiscordControlService, type DiscordControlService, type DiscordHealthSnapshot
} from "./control/service";
import { createPrismaDiscordSetupSources, discordAssistantMcpServerIds } from "./control/setupSources";
import { createDiscordControlCache, effectiveDiscordControl, isDiscordBotActive, type DiscordEffectiveControl } from "./control/state";
import { createDiscordIntake, discordHandlerRegistry, type DiscordHandlerRegistry, type DiscordIntake } from "./intake";
import { createDiscordRest, type DiscordRest } from "./rest";
import { createDiscordSession, type DiscordSession } from "./session";
import { createPrismaDiscordConversationStore, type DiscordConversationKind, type DiscordConversationStore } from "./store/conversations";
import { createPrismaDiscordLimitStore, type DiscordLimitStore } from "./store/limits";
import { createPrismaDiscordReplyStore, type DiscordReplyStore } from "./store/replies";
import { createDiscordTransport, resolveDiscordNetwork, type DiscordNetwork, type DiscordTransport } from "./transport";

/**
 * Discord Connect for this application process (one replica), shared across
 * route bundles through `globalThis`: the control service and cache, the REST
 * client every send goes through (its `authorize` is the kill switch), the
 * stores, the intake with its lanes and handler registry, and the one gateway
 * session, started from `instrumentation.ts` and re-evaluated after every
 * administrator change and once a minute.
 */

export type DiscordDefaults = Readonly<{
  /** The control snapshot (30 s, dropped on every administrator write). */
  control(): Promise<DiscordEffectiveControl>;
  controlService: DiscordControlService;
  repository: DiscordControlRepository;
  /** The bot's REST client: refuses every call unsent (`discord_disabled`) while the bot is off. */
  rest(): DiscordRest;
  replies: DiscordReplyStore;
  conversations: DiscordConversationStore;
  limits: DiscordLimitStore;
  directory: DiscordChannelDirectory;
  registry: DiscordHandlerRegistry;
  intake: DiscordIntake;
  session: DiscordSession;
}>;

const globalForDiscord = globalThis as unknown as {
  __aiqsaDiscord?: DiscordDefaults;
  __aiqsaDiscordStarted?: boolean;
  __aiqsaDiscordTimer?: ReturnType<typeof setInterval>;
};

const CONVERSATION_CHANNEL_TYPES: Readonly<Record<DiscordConversationKind, number>> = {
  channel: 0, dm: 1, forum_post: 11, thread: 11, voice_chat: 2
};

function createDefaults(): DiscordDefaults {
  let network: DiscordNetwork | undefined;
  let transport: DiscordTransport | undefined;
  // An invalid connect address throws here, on first use; the session records it as health.
  const resolveNetwork = () => network ??= resolveDiscordNetwork();
  const resolveTransport = () => transport ??= createDiscordTransport({ network: resolveNetwork() });
  const repository = createPrismaDiscordControlRepository(prisma);
  const cache = createDiscordControlCache({ load: async () => effectiveDiscordControl(await repository.read(), () => getSecretEncryptionKey()) });
  const control = () => cache.get();
  let botRest: DiscordRest | undefined;
  const rest = () => botRest ??= createDiscordRest({
    authorize: async () => isDiscordBotActive(await cache.get()),
    token: async () => (await cache.get()).bot?.token ?? null,
    transport: resolveTransport()
  });
  const tokenRest = (token: string) => createDiscordRest({ token: () => token, transport: resolveTransport() });
  const replies = createPrismaDiscordReplyStore(prisma);
  const conversations = createPrismaDiscordConversationStore(prisma);
  const limits = createPrismaDiscordLimitStore(prisma);
  const directory = createDiscordChannelDirectory();
  const registry = discordHandlerRegistry();
  const membership = createDiscordMembership({ rest: async () => rest() });

  async function lookupChannel(channelId: string): Promise<DiscordChannelInfo | null> {
    const conversation = await conversations.findByChannel(channelId);
    if (conversation) {
      return {
        guildId: conversation.guildId, id: conversation.discordChannelId, parentId: conversation.parentChannelId,
        type: CONVERSATION_CHANNEL_TYPES[conversation.kind]
      };
    }
    const answer = await rest().getChannel(channelId);
    return answer.ok ? discordChannelInfo(answer.value) : null;
  }

  const intake = createDiscordIntake({
    backfillSource: {
      conversations: async (since) => (await conversations.listForBackfill({ limit: 200, since }))
        .map((conversation) => ({ channelId: conversation.discordChannelId, guildId: conversation.guildId })),
      messagesAfter: async (channelId, afterId) => {
        const page = await rest().listChannelMessages(channelId, { after: afterId, limit: 100 });
        return page.ok ? page.value : null;
      }
    },
    control,
    directory,
    lookupChannel,
    membership,
    onBotRole: ({ guildId, roleId }) => {
      void (async () => {
        const current = await cache.get();
        if (!current.bot || current.guildId !== guildId || current.bot.roleId === roleId) return;
        await repository.recordBotRole({ generation: current.bot.generation, guildId, roleId });
        cache.invalidate();
      })().catch((error: unknown) => {
        logEvent("service_operation", { code: "discord_health_write_failed", error, outcome: "failed", stage: "write", subsystem: "discord" });
      });
    },
    registry
  });

  /** A resumed session hears no `GUILD_CREATE`: the server's channels are read once per connection instead. */
  async function learnChannels(): Promise<void> {
    const current = await cache.get();
    if (!isDiscordBotActive(current) || !current.guildId) return;
    const answer = await rest().listGuildChannels(current.guildId);
    if (!answer.ok) return;
    for (const entry of answer.value) {
      const channel = discordChannelInfo(entry, current.guildId);
      if (channel) directory.remember(channel);
    }
  }

  const session = createDiscordSession({
    control,
    gatewayBot: (token) => tokenRest(token).getGatewayBot(),
    network: resolveNetwork,
    onDispatch: (dispatch) => intake.accept(dispatch),
    onReady: (kind) => {
      void (async () => {
        await learnChannels();
        // A new session may have missed messages while none was connected.
        if (kind === "identified") await intake.backfill();
      })().catch((error: unknown) => {
        logEvent("service_operation", { code: "discord_backfill_failed", error, outcome: "failed", stage: "recovery", subsystem: "discord" });
      });
    },
    store: repository
  });

  const loadCatalogData = createPrismaCatalogDataLoader({ prisma });
  const controlService = createDiscordControlService({
    assistantName: async (assistantId) => (await prisma.assistantDefinition.findUnique({ select: { name: true }, where: { id: assistantId } }))?.name ?? null,
    cache,
    connected: () => session.connected(),
    createRest: tokenRest,
    createServiceAccount: async (tx, input) => {
      const created = await createServiceAccount(tx, input);
      return created.kind === "created" ? { kind: "created", userId: created.account.id } : { kind: created.kind };
    },
    enableMcpServers: async ({ assistantId, serviceUserId }) => {
      const serverIds = await discordAssistantMcpServerIds(prisma, assistantId);
      for (const serverId of serverIds) {
        await mcpRepository.updateUserServer({ enabled: true, installationOnly: true, serverId, userId: serviceUserId });
      }
      if (serverIds.length > 0) kickDefaultMcpRuntime(serviceUserId);
    },
    encryptionKey: () => getSecretEncryptionKey(),
    hooks: discordControlHooks(),
    isAssistantAvailable: (tx, input) => isAssistantAvailable(tx, {
      assistantId: input.assistantId, lock: true, scope: { kind: "personal", userId: input.userId }
    }),
    listAssistants: async (serviceUserId) => {
      const candidates = await prisma.assistantDefinition.findMany({
        orderBy: { name: "asc" },
        select: { id: true },
        take: 1_000,
        where: { archivedAt: null, OR: [{ ownerUserId: serviceUserId }, { publications: { some: {} } }] }
      });
      const identities = await availableAssistantIdentities(prisma, { assistantIds: candidates.map((entry) => entry.id), userId: serviceUserId });
      return candidates.flatMap((entry) => {
        const identity = identities.get(entry.id);
        return identity ? [{ id: entry.id, name: identity.name }] : [];
      });
    },
    repository,
    setupSources: createPrismaDiscordSetupSources({
      assistantRepository: defaultAssistantRepository,
      loadCatalogData,
      monthlyBudgetMicros: async (userId) => (await usageLimitsRepository.loadUsageLimitStatus(userId, new Date())).effective.monthlyBudgetMicros.value,
      prisma
    })
  });

  return Object.freeze({
    control, controlService, conversations, directory, intake, limits, registry, replies, repository, rest, session
  });
}

export function getDefaultDiscord(): DiscordDefaults {
  globalForDiscord.__aiqsaDiscord ??= createDefaults();
  return globalForDiscord.__aiqsaDiscord;
}

/**
 * Starts the gateway session when the bot is on, re-evaluated after every
 * administrator change (within seconds) and once a minute. Handlers register
 * through the registry before or after; intake reads it on every event.
 */
export function startDefaultDiscord(): void {
  const discord = getDefaultDiscord();
  if (!globalForDiscord.__aiqsaDiscordStarted) {
    globalForDiscord.__aiqsaDiscordStarted = true;
    const reevaluate = () => {
      void discord.session.reevaluate().catch((error: unknown) => {
        logEvent("service_operation", { code: "discord_session_failed", error, outcome: "failed", stage: "reconcile", subsystem: "discord" });
      });
    };
    discordControlHooks().onChange(reevaluate);
    globalForDiscord.__aiqsaDiscordTimer = setInterval(reevaluate, 60_000);
    globalForDiscord.__aiqsaDiscordTimer.unref?.();
  }
  void discord.session.reevaluate().catch((error: unknown) => {
    logEvent("service_operation", { code: "discord_session_failed", error, outcome: "failed", stage: "startup", subsystem: "discord" });
  });
}

/** Route-facing services, built on first use rather than at module load. */
export const defaultDiscordControlService: DiscordControlService = Object.freeze({
  createServiceAccount: (input) => getDefaultDiscord().controlService.createServiceAccount(input),
  disable: (input) => getDefaultDiscord().controlService.disable(input),
  enable: (input) => getDefaultDiscord().controlService.enable(input),
  health: () => getDefaultDiscord().controlService.health(),
  listAssistants: () => getDefaultDiscord().controlService.listAssistants(),
  listChannels: (guildId) => getDefaultDiscord().controlService.listChannels(guildId),
  listGuilds: () => getDefaultDiscord().controlService.listGuilds(),
  read: () => getDefaultDiscord().controlService.read(),
  setAssistant: (input) => getDefaultDiscord().controlService.setAssistant(input),
  setChannels: (input) => getDefaultDiscord().controlService.setChannels(input),
  setDirectMessages: (input) => getDefaultDiscord().controlService.setDirectMessages(input),
  setGuild: (input) => getDefaultDiscord().controlService.setGuild(input),
  setLimits: (input) => getDefaultDiscord().controlService.setLimits(input),
  setTestAccess: (input) => getDefaultDiscord().controlService.setTestAccess(input),
  testAndSave: (input) => getDefaultDiscord().controlService.testAndSave(input)
});

/** What the Control Center's attention rules read about Discord: the switch, recorded session health and setup. */
export async function readDiscordHealthSnapshot(): Promise<DiscordHealthSnapshot> {
  return getDefaultDiscord().controlService.health();
}
