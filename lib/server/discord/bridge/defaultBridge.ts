import type { RequestAuthResolver } from "../../auth/requestAuth";
import { connectorRequestAuth } from "../../connectors/requestAuth";
import { lazyConnectorLoader, lazyConnectorRunGateway } from "../../connectors/runGateway";
import { prisma } from "../../prisma";
import { discordControlHooks } from "../control/hooks";
import { isDiscordBotActive } from "../control/state";
import type { DiscordDefaults } from "../defaultDiscord";
import { createDiscordAnswerFiles, createDiscordAttachments } from "../files";
import { createDiscordTransport, type DiscordTransport } from "../transport";
import { getRunAttachmentLimits } from "../../runs/attachmentLimits";
import { defaultTelegramFileReader } from "../../telegram/files";
import { defaultUploadMaxBytes } from "../../uploads/validation";
import { createDiscordBridge, type DiscordBridge, type DiscordShareLinks } from "./index";
import { createPrismaDiscordRunFacts } from "./runFacts";
import { createDiscordUploads, type DiscordUploadServices } from "./uploads";

/**
 * The application's one Discord bridge (one replica), shared across route
 * bundles through `globalThis` like the handler registry it fills. Its AIQSA
 * side (run admission, follow-ups, Stop, reads, shares, uploads) loads on the
 * first question, so starting the bot never loads the run stack. Every
 * in-process request is the service account's, re-read on every call: active,
 * of kind `service`, still the bound service account, the bot on. Deliveries a
 * restart interrupted are swept right after start, once a minute and after
 * every administrator change of the bot.
 */

type DiscordBridgeDefaults = Pick<DiscordDefaults, "control" | "controlService" | "conversations" | "intake" | "limits" | "registry" |
  "replies" | "rest">;
type RunningBridge = Readonly<{ bridge: DiscordBridge; owner: DiscordBridgeDefaults; unregister: () => void }>;

const globalForBridge = globalThis as unknown as { __aiqsaDiscordBridge?: RunningBridge };

/** The request resolver of the service account's in-process calls. */
export function discordRequestAuth(discord: Pick<DiscordDefaults, "control">, userId: string): RequestAuthResolver {
  return connectorRequestAuth({
    allowed: async () => {
      const control = await discord.control();
      if (!isDiscordBotActive(control) || control.serviceUserId !== userId) return false;
      const user = await prisma.user.findUnique({ select: { kind: true }, where: { id: userId } });
      return user?.kind === "service";
    },
    sessionId: "discord",
    userId
  });
}

export function startDiscordBridge(discord: DiscordBridgeDefaults): DiscordBridge {
  const running = globalForBridge.__aiqsaDiscordBridge;
  if (running?.owner === discord) return running.bridge;
  // Services rebuilt in this process (a reload): the old bridge's handlers leave with them.
  running?.unregister();
  const auth = (userId: string) => discordRequestAuth(discord, userId);
  const gateway = lazyConnectorRunGateway(async () => (await import("../../connectors/defaultRunGateway"))
    .createDefaultConnectorRunGateway({ auth, connectorTurn: "discord" }));
  const shareHandler = lazyConnectorLoader(async () => {
    const [{ createShareChatHandler }, { createPrismaShareRepository }, { getAuthConfig }, { connectorInternalRequest }] = await Promise.all([
      import("../../shares/handlers"), import("../../shares/prismaRepository"), import("../../auth/config"),
      import("../../connectors/defaultRunGateway")
    ]);
    return { appBaseUrl: () => getAuthConfig().appBaseUrl, createShareChatHandler, connectorInternalRequest, repository: createPrismaShareRepository() };
  });
  const shares: DiscordShareLinks = Object.freeze({
    async create({ assistantMessageId, chatId, userId }) {
      const loaded = await shareHandler();
      const response = await loaded.createShareChatHandler({ repository: loaded.repository, resolveAuth: auth(userId) })(
        loaded.connectorInternalRequest(`/api/chats/${encodeURIComponent(chatId)}/share`, "POST", { activeLeafMessageId: assistantMessageId }),
        { params: { chatId } }
      );
      if (!response.ok) return null;
      const body = await response.json().catch(() => null) as { share?: { publicPath?: unknown } } | null;
      const path = body?.share?.publicPath;
      return typeof path === "string" && path.startsWith("/s/") ? new URL(path, loaded.appBaseUrl()).toString() : null;
    }
  });
  const uploadServices = lazyConnectorLoader(async (): Promise<DiscordUploadServices> => {
    const [{ createUploadHandler }, { defaultUploadHandlerDeps }] = await Promise.all([
      import("../../uploads/handlers"), import("../../uploads/defaultUploadHandlerDeps")
    ]);
    return {
      async attachmentStatus({ attachmentId, userId }) {
        const attachment = await prisma.attachment.findFirst({ select: { status: true }, where: { id: attachmentId, userId } });
        return attachment?.status ?? null;
      },
      upload: ({ request, userId }) => createUploadHandler({ ...defaultUploadHandlerDeps, resolveAuth: auth(userId) })(request)
    };
  });
  const uploads = createDiscordUploads({ services: uploadServices });
  // CDN downloads carry no token: their own transport over the same network settings (allowlist, egress address, test origin).
  let cdn: DiscordTransport | undefined;
  const attachments = createDiscordAttachments({
    download: async (input) => (cdn ??= createDiscordTransport()).download(input),
    limits: () => {
      const run = getRunAttachmentLimits();
      return {
        runMaxBytes: Math.min(run.maxMaterializedBytes, Math.floor(run.maxEncodedBytes * 3 / 4)), runMaxCount: run.maxCount,
        uploadMaxBytes: defaultUploadMaxBytes()
      };
    },
    rest: discord.rest,
    uploads
  });
  const bridge = createDiscordBridge({
    answerFiles: createDiscordAnswerFiles({ read: defaultTelegramFileReader() }),
    attachments,
    control: discord.control,
    conversations: discord.conversations,
    facts: createPrismaDiscordRunFacts(prisma),
    gateway,
    lanes: discord.intake.lanes,
    limits: discord.limits,
    replies: discord.replies,
    rest: discord.rest,
    setupReady: async () => (await discord.controlService.health()).setupReady,
    shares,
    uploads
  });
  const removers = [bridge.register(discord.registry)];
  const unregister = () => {
    for (const remove of removers) remove();
  };
  globalForBridge.__aiqsaDiscordBridge = { bridge, owner: discord, unregister };
  const startedAt = new Date();
  // The sweeps leave with the handlers too.
  removers.push(bridge.startRecovery(startedAt), discordControlHooks().onChange(() => { void bridge.recover(startedAt); }));
  return bridge;
}

/** The running bridge, for features that follow its questions; null before start. */
export function discordBridge(): DiscordBridge | null {
  return globalForBridge.__aiqsaDiscordBridge?.bridge ?? null;
}
