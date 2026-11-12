import { Prisma, type DiscordBotControl, type PrismaClient } from "@prisma/client";
import type { DiscordChannelMode, DiscordLimits } from "../../../contracts/discord";
import { retainDatabaseFailure } from "../../observability/databaseFailure";

/**
 * The installation's Discord control row. Every administrator write locks the
 * row, refuses a stale `expectedVersion` and bumps the version; session
 * health, the persisted gateway session, IDENTIFY permits and the bot's
 * learned role never bump it, so the gateway never makes an administrator's
 * next edit stale. Those writes name the token generation they belong to, so a
 * session of a replaced token writes nothing.
 */

export const DISCORD_CONTROL_ID = "installation";

export type DiscordPersistedSession = Readonly<{
  generation: number;
  sessionId: string;
  seq: number | null;
  resumeGatewayUrl: string;
}>;

export type DiscordControlRecord = Readonly<{
  enabled: boolean;
  enabledAt: Date | null;
  tokenEnvelope: string | null;
  tokenGeneration: number;
  applicationId: string | null;
  botUserId: string | null;
  botUsername: string | null;
  botRoleId: string | null;
  guildId: string | null;
  guildName: string | null;
  channelMode: DiscordChannelMode;
  channelIds: readonly string[];
  dmEnabled: boolean;
  testAuthorIds: readonly string[];
  testChannelIds: readonly string[];
  callNames: readonly string[];
  serviceUserId: string | null;
  assistantId: string | null;
  limits: DiscordLimits;
  session: DiscordPersistedSession | null;
  identifyAt: readonly Date[];
  lastConnectedAt: Date | null;
  lastEventAt: Date | null;
  lastFailureAt: Date | null;
  lastFailureCode: string | null;
  version: number;
}>;

export type DiscordControlWrite =
  | Readonly<{ kind: "ok"; record: DiscordControlRecord }>
  | Readonly<{ kind: "stale" }>
  | Readonly<{ kind: "token_missing" }>
  | Readonly<{ kind: "service_account_missing" }>
  | Readonly<{ kind: "assistant_unavailable" }>
  | Readonly<{ kind: "actor_forbidden" }>;

/** The session health facts a gateway writes; `failure: null` clears a recorded failure. */
export type DiscordHealthWrite = Readonly<{
  generation: number;
  connectedAt?: Date;
  failure?: Readonly<{ code: string; at: Date; keepEarlier?: boolean }> | null;
}>;

export type DiscordIdentifyReservation =
  | Readonly<{ ok: true; count: number }>
  | Readonly<{ ok: false; retryAt: Date; count: number }>;

export type DiscordControlRepository = Readonly<{
  read(): Promise<DiscordControlRecord>;
  /** Stores a token Discord proved; the next generation drops the old token's session, health and learned role. */
  saveToken(input: Readonly<{
    actorUserId: string; expectedVersion: number; applicationId: string; botUserId: string; botUsername: string;
    seal(generation: number): string;
  }>): Promise<DiscordControlWrite>;
  setEnabled(input: Readonly<{ actorUserId: string; enabled: boolean; expectedVersion: number; now: Date }>): Promise<DiscordControlWrite>;
  /** Another server forgets the old server's channels, test channels and the bot's role there. */
  setGuild(input: Readonly<{ actorUserId: string; expectedVersion: number; guildId: string; guildName: string }>): Promise<DiscordControlWrite>;
  setChannels(input: Readonly<{
    actorUserId: string; expectedVersion: number; channelMode: DiscordChannelMode; channelIds: readonly string[];
  }>): Promise<DiscordControlWrite>;
  setDirectMessages(input: Readonly<{ actorUserId: string; expectedVersion: number; dmEnabled: boolean }>): Promise<DiscordControlWrite>;
  setTestAccess(input: Readonly<{
    actorUserId: string; expectedVersion: number; testAuthorIds: readonly string[]; testChannelIds: readonly string[];
  }>): Promise<DiscordControlWrite>;
  setCallNames(input: Readonly<{ actorUserId: string; expectedVersion: number; callNames: readonly string[] }>): Promise<DiscordControlWrite>;
  /**
   * Binds a service account: an existing bound account (whatever its status)
   * stays and nothing changes; otherwise `create` makes one in the same
   * transaction, so concurrent clicks bind exactly one.
   */
  bindServiceAccount(input: Readonly<{
    actorUserId: string; expectedVersion: number;
    create(tx: Prisma.TransactionClient): Promise<Readonly<{ kind: "created"; userId: string }> | Readonly<{ kind: "actor_forbidden" }>>;
  }>): Promise<DiscordControlWrite & Readonly<{ created?: boolean }>>;
  /** `available` runs inside the row lock against the bound service account. */
  setAssistant(input: Readonly<{
    actorUserId: string; expectedVersion: number; assistantId: string;
    available(tx: Prisma.TransactionClient, serviceUserId: string): Promise<boolean>;
  }>): Promise<DiscordControlWrite>;
  setLimits(input: Readonly<{ actorUserId: string; expectedVersion: number; limits: DiscordLimits }>): Promise<DiscordControlWrite>;
  recordHealth(input: DiscordHealthWrite): Promise<void>;
  /** The session to resume after a restart (READY's new session). */
  saveSession(input: Readonly<{ generation: number; session: Omit<DiscordPersistedSession, "generation"> }>): Promise<void>;
  /**
   * Clears the stored session only while it is still `sessionId`: a stale
   * process giving up its own session never wipes a newer one another process stored.
   */
  forgetSession(input: Readonly<{ generation: number; sessionId: string }>): Promise<void>;
  /** The latest sequence and event time of the persisted session `sessionId`. */
  saveProgress(input: Readonly<{ generation: number; sessionId: string; seq: number | null; lastEventAt: Date }>): Promise<void>;
  /** Takes one IDENTIFY permit unless `limit` were granted within `windowMs` (any token, any process). */
  reserveIdentify(input: Readonly<{ now: Date; limit: number; windowMs: number }>): Promise<DiscordIdentifyReservation>;
  recordBotRole(input: Readonly<{ generation: number; guildId: string; roleId: string | null }>): Promise<void>;
}>;

type ControlClient = Pick<PrismaClient, "$transaction" | "discordBotControl">;

function snowflake(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

function snowflakes(values: readonly bigint[] | null): string[] {
  return (values ?? []).map((value) => value.toString());
}

export function discordControlRecord(row: DiscordBotControl): DiscordControlRecord {
  const session = row.sessionId !== null && row.sessionGeneration !== null && row.resumeGatewayUrl !== null
    ? { generation: row.sessionGeneration, sessionId: row.sessionId, seq: row.sessionSeq, resumeGatewayUrl: row.resumeGatewayUrl }
    : null;
  return {
    applicationId: snowflake(row.applicationId),
    assistantId: row.assistantId,
    botRoleId: snowflake(row.botRoleId),
    botUserId: snowflake(row.botUserId),
    botUsername: row.botUsername,
    callNames: [...(row.callNames ?? [])],
    channelIds: snowflakes(row.channelIds),
    channelMode: row.channelMode,
    dmEnabled: row.dmEnabled,
    enabled: row.enabled,
    enabledAt: row.enabledAt,
    guildId: snowflake(row.guildId),
    guildName: row.guildName,
    identifyAt: [...(row.identifyAt ?? [])],
    lastConnectedAt: row.lastConnectedAt,
    lastEventAt: row.lastEventAt,
    lastFailureAt: row.lastFailureAt,
    lastFailureCode: row.lastFailureCode,
    limits: {
      parallelThreads: row.parallelThreads,
      perAuthorDaily: row.perAuthorDaily,
      perAuthorHourly: row.perAuthorHourly,
      perThreadHourly: row.perThreadHourly
    },
    serviceUserId: row.serviceUserId,
    session,
    testAuthorIds: snowflakes(row.testAuthorIds),
    testChannelIds: snowflakes(row.testChannelIds),
    tokenEnvelope: row.tokenEnvelope,
    tokenGeneration: row.tokenGeneration,
    version: row.version
  };
}

async function lockControl(tx: Prisma.TransactionClient): Promise<DiscordBotControl> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DiscordBotControl" WHERE "id" = ${DISCORD_CONTROL_ID} FOR UPDATE`)
    .catch(retainDatabaseFailure);
  const row = await tx.discordBotControl.findUnique({ where: { id: DISCORD_CONTROL_ID } }).catch(retainDatabaseFailure);
  if (!row) throw new Error("discord_control_missing");
  return row;
}

const NO_SESSION = { resumeGatewayUrl: null, sessionGeneration: null, sessionId: null, sessionSeq: null } as const;
const NO_HEALTH = { lastConnectedAt: null, lastEventAt: null, lastFailureAt: null, lastFailureCode: null } as const;

type WorkResult = DiscordControlWrite | Prisma.DiscordBotControlUncheckedUpdateInput;

export function createPrismaDiscordControlRepository(prisma: ControlClient): DiscordControlRepository {
  async function write(
    expectedVersion: number,
    work: (tx: Prisma.TransactionClient, current: DiscordBotControl) => Promise<WorkResult>
  ): Promise<DiscordControlWrite> {
    return prisma.$transaction(async (tx) => {
      const current = await lockControl(tx);
      if (current.version !== expectedVersion) return { kind: "stale" } as const;
      const data = await work(tx, current);
      if ("kind" in data) return data as DiscordControlWrite;
      const updated = await tx.discordBotControl.update({
        data: { ...data, version: { increment: 1 } }, where: { id: DISCORD_CONTROL_ID }
      }).catch(retainDatabaseFailure);
      return { kind: "ok", record: discordControlRecord(updated) } as const;
    }).catch(retainDatabaseFailure);
  }

  /** A gateway write of the token generation `generation`; a replaced token's session writes nothing. */
  async function sessionWrite(generation: number, data: Prisma.DiscordBotControlUpdateManyMutationInput): Promise<void> {
    await prisma.discordBotControl.updateMany({ data, where: { id: DISCORD_CONTROL_ID, tokenGeneration: generation } })
      .catch(retainDatabaseFailure);
  }

  return Object.freeze({
    async read() {
      const row = await prisma.discordBotControl.findUnique({ where: { id: DISCORD_CONTROL_ID } }).catch(retainDatabaseFailure);
      if (!row) throw new Error("discord_control_missing");
      return discordControlRecord(row);
    },

    saveToken(input) {
      return write(input.expectedVersion, async (_tx, current) => {
        const generation = current.tokenGeneration + 1;
        const sameBot = current.botUserId !== null && current.botUserId.toString() === input.botUserId;
        return {
          ...NO_SESSION,
          ...NO_HEALTH,
          applicationId: BigInt(input.applicationId),
          botUserId: BigInt(input.botUserId),
          botUsername: input.botUsername,
          tokenEnvelope: input.seal(generation),
          tokenGeneration: generation,
          updatedByUserId: input.actorUserId,
          // The managed role belongs to one bot.
          ...(sameBot ? {} : { botRoleId: null })
        };
      });
    },

    setEnabled(input) {
      return write(input.expectedVersion, async (_tx, current) => {
        if (input.enabled && current.tokenEnvelope === null) return { kind: "token_missing" } as const;
        return {
          enabled: input.enabled,
          // Questions sent while the bot was off are never answered after it comes back.
          ...(input.enabled && !current.enabled ? { enabledAt: input.now } : {}),
          updatedByUserId: input.actorUserId
        };
      });
    },

    setGuild(input) {
      return write(input.expectedVersion, async (_tx, current) => {
        const same = current.guildId !== null && current.guildId.toString() === input.guildId;
        return {
          guildId: BigInt(input.guildId),
          guildName: input.guildName,
          updatedByUserId: input.actorUserId,
          ...(same ? {} : { botRoleId: null, channelIds: [], testChannelIds: [] })
        };
      });
    },

    setChannels(input) {
      return write(input.expectedVersion, async () => ({
        channelIds: input.channelIds.map((id) => BigInt(id)),
        channelMode: input.channelMode,
        updatedByUserId: input.actorUserId
      }));
    },

    setDirectMessages(input) {
      return write(input.expectedVersion, async () => ({ dmEnabled: input.dmEnabled, updatedByUserId: input.actorUserId }));
    },

    setTestAccess(input) {
      return write(input.expectedVersion, async () => ({
        testAuthorIds: input.testAuthorIds.map((id) => BigInt(id)),
        testChannelIds: input.testChannelIds.map((id) => BigInt(id)),
        updatedByUserId: input.actorUserId
      }));
    },

    setCallNames(input) {
      return write(input.expectedVersion, async () => ({ callNames: [...input.callNames], updatedByUserId: input.actorUserId }));
    },

    async bindServiceAccount(input) {
      let created = false;
      const result = await write(input.expectedVersion, async (tx, current) => {
        if (current.serviceUserId !== null) {
          const existing = await tx.user.findUnique({ select: { id: true }, where: { id: current.serviceUserId } })
            .catch(retainDatabaseFailure);
          if (existing) return { kind: "ok", record: discordControlRecord(current) } as const;
        }
        const account = await input.create(tx);
        if (account.kind !== "created") return { kind: "actor_forbidden" } as const;
        created = true;
        return { serviceUserId: account.userId, updatedByUserId: input.actorUserId };
      });
      return result.kind === "ok" ? { ...result, created } : result;
    },

    setAssistant(input) {
      return write(input.expectedVersion, async (tx, current) => {
        if (current.serviceUserId === null) return { kind: "service_account_missing" } as const;
        if (!await input.available(tx, current.serviceUserId)) return { kind: "assistant_unavailable" } as const;
        return { assistantId: input.assistantId, updatedByUserId: input.actorUserId };
      });
    },

    setLimits(input) {
      return write(input.expectedVersion, async () => ({
        parallelThreads: input.limits.parallelThreads,
        perAuthorDaily: input.limits.perAuthorDaily,
        perAuthorHourly: input.limits.perAuthorHourly,
        perThreadHourly: input.limits.perThreadHourly,
        updatedByUserId: input.actorUserId
      }));
    },

    async recordHealth(input) {
      const data: Prisma.DiscordBotControlUpdateManyMutationInput = {
        ...(input.connectedAt ? { lastConnectedAt: input.connectedAt } : {}),
        ...(input.failure === null ? { lastFailureAt: null, lastFailureCode: null } : {})
      };
      if (input.failure) {
        if (input.failure.keepEarlier) {
          // An outage keeps the time it started, so its duration is what the attention rule measures.
          await prisma.discordBotControl.updateMany({
            data: { lastFailureAt: input.failure.at, lastFailureCode: input.failure.code },
            where: { id: DISCORD_CONTROL_ID, lastFailureCode: null, tokenGeneration: input.generation }
          }).catch(retainDatabaseFailure);
          if (Object.keys(data).length === 0) return;
        } else {
          data.lastFailureAt = input.failure.at;
          data.lastFailureCode = input.failure.code;
        }
      }
      if (Object.keys(data).length > 0) await sessionWrite(input.generation, data);
    },

    async saveSession(input) {
      await sessionWrite(input.generation, {
        resumeGatewayUrl: input.session.resumeGatewayUrl,
        sessionGeneration: input.generation,
        sessionId: input.session.sessionId,
        sessionSeq: input.session.seq
      });
    },

    async forgetSession(input) {
      await prisma.discordBotControl.updateMany({
        data: NO_SESSION,
        where: { id: DISCORD_CONTROL_ID, sessionGeneration: input.generation, sessionId: input.sessionId, tokenGeneration: input.generation }
      }).catch(retainDatabaseFailure);
    },

    async saveProgress(input) {
      await prisma.discordBotControl.updateMany({
        data: { lastEventAt: input.lastEventAt, ...(input.seq !== null ? { sessionSeq: input.seq } : {}) },
        where: { id: DISCORD_CONTROL_ID, sessionGeneration: input.generation, sessionId: input.sessionId, tokenGeneration: input.generation }
      }).catch(retainDatabaseFailure);
    },

    async reserveIdentify(input) {
      return prisma.$transaction(async (tx) => {
        const current = await lockControl(tx);
        const since = input.now.getTime() - input.windowMs;
        const recent = (current.identifyAt ?? []).filter((at) => at.getTime() > since).sort((left, right) => left.getTime() - right.getTime());
        if (recent.length >= input.limit) {
          return { count: recent.length, ok: false, retryAt: new Date(recent[recent.length - input.limit]!.getTime() + input.windowMs) } as const;
        }
        await tx.discordBotControl.update({ data: { identifyAt: [...recent, input.now] }, where: { id: DISCORD_CONTROL_ID } })
          .catch(retainDatabaseFailure);
        return { count: recent.length + 1, ok: true } as const;
      }).catch(retainDatabaseFailure);
    },

    async recordBotRole(input) {
      await prisma.discordBotControl.updateMany({
        data: { botRoleId: input.roleId === null ? null : BigInt(input.roleId) },
        where: { guildId: BigInt(input.guildId), id: DISCORD_CONTROL_ID, tokenGeneration: input.generation }
      }).catch(retainDatabaseFailure);
    }
  });
}
