import type { PrismaClient } from "@prisma/client";
import type { DiscordLimits } from "../../../contracts/discord";
import { retainDatabaseFailure } from "../../observability/databaseFailure";

/**
 * Discord's own limits (PRD D-13, O-26): questions per Discord author per hour
 * and per day, and per conversation per hour, counted over `DiscordReply`
 * rows. Only questions that went to a run count (answers and follow-ups);
 * refused ones never do, so a refusal cannot keep its author locked out. Test
 * questions (PRD D-36) are neither refused by these limits (the bridge skips
 * the check) nor counted toward people's: an end-to-end bot asks dozens in a
 * row, often in the same thread as people. The Assistant's monthly budget and
 * the model key's limit still apply to them. The service account's own
 * message limits never apply to Discord runs.
 */

export const DISCORD_HOUR_MS = 3_600_000;
export const DISCORD_DAY_MS = 24 * DISCORD_HOUR_MS;
/** A limit's short refusal text goes out at most once per author or conversation in this window; later ones get only ❌. */
export const DISCORD_LIMIT_NOTICE_INTERVAL_MS = DISCORD_HOUR_MS;

export type DiscordLimitWindow = Readonly<{
  count: number;
  limit: number;
  /** When the window next has room, once `count` reached `limit`. */
  freesAt: Date | null;
}>;

export type DiscordLimitUsage = Readonly<{
  authorHour: DiscordLimitWindow;
  authorDay: DiscordLimitWindow;
  /** Null for a question without a conversation yet (a new thread starts at zero). */
  threadHour: DiscordLimitWindow | null;
}>;

/** The first window the question would exceed, in the order author hour, author day, thread hour. */
export function discordLimitExceeded(usage: DiscordLimitUsage):
  | Readonly<{ kind: "author" | "thread"; window: "hour" | "day"; limit: number; freesAt: Date | null }>
  | null {
  if (usage.authorHour.count >= usage.authorHour.limit) return { freesAt: usage.authorHour.freesAt, kind: "author", limit: usage.authorHour.limit, window: "hour" };
  if (usage.authorDay.count >= usage.authorDay.limit) return { freesAt: usage.authorDay.freesAt, kind: "author", limit: usage.authorDay.limit, window: "day" };
  if (usage.threadHour && usage.threadHour.count >= usage.threadHour.limit) {
    return { freesAt: usage.threadHour.freesAt, kind: "thread", limit: usage.threadHour.limit, window: "hour" };
  }
  return null;
}

export type DiscordLimitStore = Readonly<{
  usage(input: Readonly<{
    discordUserId: string; conversationId: string | null; now: Date; limits: Pick<DiscordLimits, "perAuthorDaily" | "perAuthorHourly" | "perThreadHourly">;
  }>): Promise<DiscordLimitUsage>;
  /** Whether a limit refusal of this kind already went out to the author or conversation within the notice interval. */
  noticeSent(input: Readonly<{ kind: "author" | "thread"; discordUserId?: string; conversationId?: string; now: Date }>): Promise<boolean>;
}>;

type LimitClient = Pick<PrismaClient, "discordReply">;

const COUNTED = { in: ["answer", "follow_up"] as ("answer" | "follow_up")[] };

export function createPrismaDiscordLimitStore(prisma: LimitClient): DiscordLimitStore {
  async function window(where: { discordUserId?: bigint; conversationId?: string }, now: Date, length: number, limit: number): Promise<DiscordLimitWindow> {
    const filter = { ...where, kind: COUNTED, receivedAt: { gt: new Date(now.getTime() - length) }, test: false };
    const count = await prisma.discordReply.count({ where: filter }).catch(retainDatabaseFailure);
    if (count < limit) return { count, freesAt: null, limit };
    // The question at ascending offset `count - limit` ages out first.
    const agingOut = await prisma.discordReply.findFirst({
      orderBy: [{ receivedAt: "asc" }, { questionMessageId: "asc" }], select: { receivedAt: true }, skip: count - limit, where: filter
    }).catch(retainDatabaseFailure);
    return { count, freesAt: agingOut ? new Date(agingOut.receivedAt.getTime() + length) : null, limit };
  }

  return Object.freeze({
    async usage(input) {
      const author = { discordUserId: BigInt(input.discordUserId) };
      const [authorHour, authorDay, threadHour] = await Promise.all([
        window(author, input.now, DISCORD_HOUR_MS, input.limits.perAuthorHourly),
        window(author, input.now, DISCORD_DAY_MS, input.limits.perAuthorDaily),
        input.conversationId
          ? window({ conversationId: input.conversationId }, input.now, DISCORD_HOUR_MS, input.limits.perThreadHourly)
          : Promise.resolve(null)
      ]);
      return { authorDay, authorHour, threadHour };
    },

    async noticeSent(input) {
      const target = input.kind === "author"
        ? input.discordUserId ? { discordUserId: BigInt(input.discordUserId) } : null
        : input.conversationId ? { conversationId: input.conversationId } : null;
      if (!target) return false;
      const found = await prisma.discordReply.findFirst({
        select: { questionMessageId: true },
        where: {
          ...target,
          kind: "refused",
          limitKind: input.kind,
          OR: [{ statusMessageId: { not: null } }, { answerMessageId: { not: null } }],
          receivedAt: { gt: new Date(input.now.getTime() - DISCORD_LIMIT_NOTICE_INTERVAL_MS) }
        }
      }).catch(retainDatabaseFailure);
      return found !== null;
    }
  });
}
