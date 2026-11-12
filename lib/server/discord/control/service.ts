import type { Prisma } from "@prisma/client";
import {
  DISCORD_NAME_MAX_LENGTH, discordAdminStateSchema, isDiscordReasonCode, type DiscordAdminState, type DiscordAssistantOptions,
  type DiscordChannelMode, type DiscordChannelOptions, type DiscordGuildOptions, type DiscordLimits
} from "../../../contracts/discord";
import { logEvent } from "../../observability";
import type { DiscordRest, DiscordRestFailure } from "../rest";
import type { DiscordControlHooks } from "./hooks";
import type { DiscordControlRecord, DiscordControlRepository, DiscordControlWrite } from "./repository";
import { discordSetupCheck, loadDiscordSetupFacts, type DiscordSetupCheck, type DiscordSetupFacts, type DiscordSetupSources } from "./setup";
import { effectiveDiscordControl, type DiscordControlCache } from "./state";
import { encryptDiscordBotToken, isDiscordBotToken } from "./tokenEnvelope";

/**
 * The administrator's Discord control: Test & Save proves a token with Discord
 * (`/users/@me`, `/oauth2/applications/@me`, Message Content on) before
 * anything is stored; Enable needs every blocking setup item to pass; Disable
 * is the kill switch the gateway and every REST send follow within seconds.
 * Every change names the version it was made against and answers the whole
 * token-free state. Listing calls name the servers, channels and Assistants an
 * administrator chooses from; names are for display only.
 */

export const DISCORD_CONTROL_ERROR_CODES = [
  "discord_assistant_unavailable",
  "discord_connect_address_invalid",
  "discord_control_stale",
  "discord_encryption_unavailable",
  "discord_guild_missing",
  "discord_message_content_disabled",
  "discord_service_account_missing",
  "discord_setup_incomplete",
  "discord_token_missing",
  "discord_token_rejected",
  "discord_token_unreadable",
  "discord_unreachable",
  "forbidden",
  "not_found"
] as const;
export type DiscordControlErrorCode = (typeof DISCORD_CONTROL_ERROR_CODES)[number];

export type DiscordControlResult<T = DiscordAdminState> =
  | Readonly<{ ok: true; state: T }>
  | Readonly<{ ok: false; code: DiscordControlErrorCode }>;

type Actor = Readonly<{ actorUserId: string; expectedVersion: number }>;

/** What the attention rules read: the switch, the session's recorded health and whether setup passes. */
export type DiscordHealthSnapshot = Readonly<{
  enabled: boolean;
  connected: boolean;
  lastConnectedAt: Date | null;
  lastFailureAt: Date | null;
  lastFailureCode: string | null;
  setupReady: boolean;
}>;

export type DiscordControlService = Readonly<{
  read(): Promise<DiscordAdminState>;
  testAndSave(input: Actor & Readonly<{ token: string }>): Promise<DiscordControlResult>;
  enable(input: Actor): Promise<DiscordControlResult>;
  disable(input: Actor): Promise<DiscordControlResult>;
  setGuild(input: Actor & Readonly<{ guildId: string }>): Promise<DiscordControlResult>;
  setChannels(input: Actor & Readonly<{ channelMode: DiscordChannelMode; channelIds: readonly string[] }>): Promise<DiscordControlResult>;
  setDirectMessages(input: Actor & Readonly<{ dmEnabled: boolean }>): Promise<DiscordControlResult>;
  setTestAccess(input: Actor & Readonly<{ testAuthorIds: readonly string[]; testChannelIds: readonly string[] }>): Promise<DiscordControlResult>;
  setCallNames(input: Actor & Readonly<{ callNames: readonly string[] }>): Promise<DiscordControlResult>;
  createServiceAccount(input: Actor): Promise<DiscordControlResult>;
  setAssistant(input: Actor & Readonly<{ assistantId: string }>): Promise<DiscordControlResult>;
  setLimits(input: Actor & Readonly<{ limits: DiscordLimits }>): Promise<DiscordControlResult>;
  listGuilds(): Promise<DiscordControlResult<DiscordGuildOptions>>;
  listChannels(guildId: string): Promise<DiscordControlResult<DiscordChannelOptions>>;
  listAssistants(): Promise<DiscordControlResult<DiscordAssistantOptions>>;
  health(): Promise<DiscordHealthSnapshot>;
}>;

/** A Discord call made for the administrator gets this hard deadline, waits for rate limits included. */
export const DISCORD_ADMIN_CALL_DEADLINE_MS = 15_000;
/** Channel names shown beside stored ids are fetched with a shorter deadline and kept a minute. */
export const DISCORD_CHANNEL_NAMES_DEADLINE_MS = 5_000;
export const DISCORD_CHANNEL_NAMES_TTL_MS = 60_000;
/** The setup result the attention rules read is kept this long for one control version. */
export const DISCORD_SETUP_CACHE_TTL_MS = 60_000;
/** APPLICATION flags GATEWAY_MESSAGE_CONTENT and GATEWAY_MESSAGE_CONTENT_LIMITED. */
export const DISCORD_MESSAGE_CONTENT_FLAGS = (1 << 18) | (1 << 19);
export const DISCORD_SERVICE_ACCOUNT_NAME = "Discord";

const BOT_USERNAME = /^[^@#:`\u0000-\u001f]{2,32}$/u;
const CHANNEL_KINDS: Readonly<Record<number, DiscordChannelOptions["channels"][number]["kind"]>> = {
  0: "text", 2: "voice", 4: "category", 5: "announcement", 13: "stage", 15: "forum", 16: "media"
};
const THREAD_TYPES = new Set([10, 11, 12]);

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function displayName(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim().slice(0, DISCORD_NAME_MAX_LENGTH);
  return trimmed ? trimmed : fallback;
}

/** Content-free: stages, outcomes and stable codes only. */
function log(fields: Readonly<{ code?: string; httpStatus?: number; outcome: "completed" | "failed"; stage: "probe" | "read" | "write" }>): void {
  logEvent("service_operation", { subsystem: "discord", ...fields });
}

/** 401 means Discord does not know the token; anything else unanswered is Discord being unreachable. */
export function discordTokenFailureCode(failure: DiscordRestFailure): "discord_token_rejected" | "discord_unreachable" {
  return failure.status === 401 ? "discord_token_rejected" : "discord_unreachable";
}

function writeFailure(write: Exclude<DiscordControlWrite, { kind: "ok" }>): DiscordControlErrorCode {
  switch (write.kind) {
    case "stale": return "discord_control_stale";
    case "token_missing": return "discord_token_missing";
    case "service_account_missing": return "discord_service_account_missing";
    case "assistant_unavailable": return "discord_assistant_unavailable";
    case "actor_forbidden": return "forbidden";
  }
}

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

export type DiscordControlServiceDeps = Readonly<{
  cache: DiscordControlCache;
  hooks: DiscordControlHooks;
  repository: DiscordControlRepository;
  encryptionKey(): Buffer;
  /** A REST client for one token, without the kill switch: administrator probes work while the bot is off. */
  createRest(token: string): DiscordRest;
  setupSources: DiscordSetupSources;
  createServiceAccount(tx: Prisma.TransactionClient, input: Readonly<{ createdByUserId: string; displayName: string }>):
    Promise<Readonly<{ kind: "created"; userId: string }> | Readonly<{ kind: "actor_forbidden" | "display_name_invalid" }>>;
  isAssistantAvailable(tx: Prisma.TransactionClient, input: Readonly<{ assistantId: string; userId: string }>): Promise<boolean>;
  assistantName(assistantId: string): Promise<string | null>;
  /** The Assistants available to the service account, by name. */
  listAssistants(serviceUserId: string): Promise<readonly Readonly<{ id: string; name: string }>[]>;
  /**
   * Switches the Assistant's MCP servers on for the service account (it has no
   * Settings of its own); a server it cannot use stays off and the setup
   * check names it.
   */
  enableMcpServers(input: Readonly<{ assistantId: string; serviceUserId: string }>): Promise<void>;
  /** Whether this process's gateway session is connected now; null when no session runs here. */
  connected(): boolean | null;
  deadlineMs?: number;
  now?: () => number;
}>;

export function createDiscordControlService(deps: DiscordControlServiceDeps): DiscordControlService {
  const deadlineMs = deps.deadlineMs ?? DISCORD_ADMIN_CALL_DEADLINE_MS;
  const now = deps.now ?? Date.now;
  let channelNames: { key: string; expiresAt: number; names: Promise<ReadonlyMap<string, string>> } | null = null;
  let setupCache: { version: number; expiresAt: number; check: Promise<DiscordSetupCheck> } | null = null;

  function token(record: DiscordControlRecord): { state: DiscordSetupFacts["tokenState"]; value: string | null } {
    let control;
    try {
      control = effectiveDiscordControl(record, deps.encryptionKey);
    } catch {
      return { state: record.tokenEnvelope ? "unreadable" : "missing", value: null };
    }
    return { state: control.tokenState, value: control.bot?.token ?? null };
  }

  function rest(tokenValue: string): DiscordRest | DiscordControlErrorCode {
    try {
      return deps.createRest(tokenValue);
    } catch {
      log({ code: "discord_connect_address_invalid", outcome: "failed", stage: "probe" });
      return "discord_connect_address_invalid";
    }
  }

  async function call<T>(work: () => Promise<{ ok: true; value: T } | DiscordRestFailure>): Promise<{ ok: true; value: T } | { ok: false; failure: DiscordRestFailure | null }> {
    const outcome = await withDeadline(work(), deadlineMs);
    if (outcome === "timeout") return { failure: null, ok: false };
    return outcome.ok ? outcome : { failure: outcome, ok: false };
  }

  async function names(record: DiscordControlRecord, tokenValue: string | null): Promise<ReadonlyMap<string, string>> {
    if (!tokenValue || record.guildId === null || record.channelIds.length === 0) return new Map();
    const key = `${record.tokenGeneration}:${record.guildId}`;
    const at = now();
    if (!channelNames || channelNames.key !== key || channelNames.expiresAt <= at) {
      const client = rest(tokenValue);
      const guildId = record.guildId;
      const load = typeof client === "string"
        ? Promise.resolve(new Map<string, string>())
        : withDeadline(client.listGuildChannels(guildId), DISCORD_CHANNEL_NAMES_DEADLINE_MS).then((outcome) => {
          if (outcome === "timeout" || !outcome.ok) throw new Error("discord_channel_names_unavailable");
          return new Map(outcome.value.flatMap((channel) => channel.name ? [[channel.id, displayName(channel.name, channel.id)] as const] : []));
        });
      const entry = { expiresAt: at + DISCORD_CHANNEL_NAMES_TTL_MS, key, names: load };
      channelNames = entry;
      load.catch(() => { if (channelNames === entry) channelNames = null; });
    }
    // Names are only for display: without them the ids still show.
    return channelNames.names.catch(() => new Map<string, string>());
  }

  async function setup(record: DiscordControlRecord): Promise<{ check: DiscordSetupCheck; facts: DiscordSetupFacts }> {
    const facts = await loadDiscordSetupFacts(record, token(record).state, deps.setupSources);
    return { check: discordSetupCheck(facts), facts };
  }

  async function stateOf(record: DiscordControlRecord): Promise<DiscordAdminState> {
    const tokenValue = token(record).value;
    const [{ check, facts }, channelNameMap, assistantName] = await Promise.all([
      setup(record),
      names(record, tokenValue),
      record.assistantId ? deps.assistantName(record.assistantId) : Promise.resolve(null)
    ]);
    setupCache = { check: Promise.resolve(check), expiresAt: now() + DISCORD_SETUP_CACHE_TTL_MS, version: record.version };
    const failureCode = isDiscordReasonCode(record.lastFailureCode) ? record.lastFailureCode : null;
    const bot = record.botUserId && record.applicationId && record.botUsername && BOT_USERNAME.test(record.botUsername)
      ? { applicationId: record.applicationId, userId: record.botUserId, username: record.botUsername }
      : null;
    return discordAdminStateSchema.parse({
      assistant: record.assistantId && assistantName
        ? { id: record.assistantId, name: assistantName.slice(0, 200) }
        : null,
      bot,
      callNames: [...record.callNames],
      channelMode: record.channelMode,
      channels: record.channelIds.map((id) => ({ id, name: channelNameMap.get(id) ?? null })),
      dmEnabled: record.dmEnabled,
      enabled: record.enabled,
      guild: record.guildId ? { id: record.guildId, name: displayName(record.guildName, record.guildId) } : null,
      health: {
        connected: record.enabled && deps.connected() === true,
        lastConnectedAt: iso(record.lastConnectedAt),
        lastEventAt: iso(record.lastEventAt),
        lastFailureAt: failureCode ? iso(record.lastFailureAt) : null,
        lastFailureCode: failureCode
      },
      limits: record.limits,
      serviceAccount: facts.serviceAccount.status === "missing"
        ? { status: "missing", userId: null }
        : { status: facts.serviceAccount.status, userId: facts.serviceAccount.userId },
      setup: check,
      testAuthorIds: [...record.testAuthorIds],
      testChannelIds: [...record.testChannelIds],
      tokenConfigured: record.tokenEnvelope !== null,
      version: record.version
    });
  }

  async function committed(record: DiscordControlRecord): Promise<DiscordControlResult> {
    deps.cache.invalidate();
    setupCache = null;
    deps.hooks.changed();
    log({ outcome: "completed", stage: "write" });
    return { ok: true, state: await stateOf(record) };
  }

  async function outcome(write: DiscordControlWrite): Promise<DiscordControlResult> {
    return write.kind === "ok" ? committed(write.record) : { code: writeFailure(write), ok: false };
  }

  async function enableMcp(record: DiscordControlRecord): Promise<void> {
    if (!record.assistantId || !record.serviceUserId) return;
    try {
      await deps.enableMcpServers({ assistantId: record.assistantId, serviceUserId: record.serviceUserId });
    } catch {
      // The setup check names a server the service account cannot run.
      log({ code: "discord_mcp_enable_failed", outcome: "failed", stage: "write" });
    }
  }

  async function storedToken(): Promise<{ client: DiscordRest } | { code: DiscordControlErrorCode }> {
    const record = await deps.repository.read();
    const stored = token(record);
    if (stored.state === "missing") return { code: "discord_token_missing" };
    if (!stored.value) return { code: "discord_token_unreadable" };
    const client = rest(stored.value);
    return typeof client === "string" ? { code: client } : { client };
  }

  return Object.freeze({
    async read() {
      return stateOf(await deps.repository.read());
    },

    async testAndSave(input) {
      const current = await deps.repository.read();
      if (current.version !== input.expectedVersion) return { code: "discord_control_stale", ok: false };
      let key: Buffer;
      try {
        key = deps.encryptionKey();
      } catch {
        log({ code: "discord_encryption_unavailable", outcome: "failed", stage: "write" });
        return { code: "discord_encryption_unavailable", ok: false };
      }
      if (!isDiscordBotToken(input.token)) return { code: "discord_token_rejected", ok: false };
      const client = rest(input.token);
      if (typeof client === "string") return { code: client, ok: false };
      const [user, application] = await Promise.all([call(() => client.getCurrentUser()), call(() => client.getCurrentApplication())]);
      for (const answer of [user, application]) {
        if (!answer.ok) {
          const code = answer.failure ? discordTokenFailureCode(answer.failure) : "discord_unreachable";
          log({ code, httpStatus: answer.failure?.status, outcome: "failed", stage: "probe" });
          return { code, ok: false };
        }
      }
      if (!user.ok || !application.ok) return { code: "discord_unreachable", ok: false };
      // A bot token always names its bot, and its application's bot is that user.
      if (user.value.bot !== true || (application.value.bot && application.value.bot.id !== user.value.id)) {
        log({ code: "discord_token_rejected", outcome: "failed", stage: "probe" });
        return { code: "discord_token_rejected", ok: false };
      }
      if (((application.value.flags ?? 0) & DISCORD_MESSAGE_CONTENT_FLAGS) === 0) {
        log({ code: "discord_message_content_disabled", outcome: "failed", stage: "probe" });
        return { code: "discord_message_content_disabled", ok: false };
      }
      log({ outcome: "completed", stage: "probe" });
      return outcome(await deps.repository.saveToken({
        actorUserId: input.actorUserId,
        applicationId: application.value.id,
        botUserId: user.value.id,
        botUsername: user.value.username.slice(0, 64),
        expectedVersion: input.expectedVersion,
        seal: (generation) => encryptDiscordBotToken({ generation, key, token: input.token })
      }));
    },

    async enable(input) {
      const current = await deps.repository.read();
      if (current.version !== input.expectedVersion) return { code: "discord_control_stale", ok: false };
      const stored = token(current);
      if (stored.state === "missing") return { code: "discord_token_missing", ok: false };
      if (stored.state === "unreadable") return { code: "discord_token_unreadable", ok: false };
      await enableMcp(current);
      const { check } = await setup(current);
      if (!check.ready) return { code: "discord_setup_incomplete", ok: false };
      return outcome(await deps.repository.setEnabled({
        actorUserId: input.actorUserId, enabled: true, expectedVersion: input.expectedVersion, now: new Date(now())
      }));
    },

    async disable(input) {
      return outcome(await deps.repository.setEnabled({
        actorUserId: input.actorUserId, enabled: false, expectedVersion: input.expectedVersion, now: new Date(now())
      }));
    },

    async setGuild(input) {
      const current = await deps.repository.read();
      if (current.version !== input.expectedVersion) return { code: "discord_control_stale", ok: false };
      const stored = await storedToken();
      if ("code" in stored) return { code: stored.code, ok: false };
      const guilds = await call(() => stored.client.listCurrentUserGuilds());
      if (!guilds.ok) {
        const code = guilds.failure ? discordTokenFailureCode(guilds.failure) : "discord_unreachable";
        log({ code, httpStatus: guilds.failure?.status, outcome: "failed", stage: "probe" });
        return { code, ok: false };
      }
      const guild = guilds.value.find((entry) => entry.id === input.guildId);
      if (!guild) return { code: "discord_guild_missing", ok: false };
      return outcome(await deps.repository.setGuild({
        actorUserId: input.actorUserId, expectedVersion: input.expectedVersion, guildId: guild.id,
        guildName: displayName(guild.name, guild.id)
      }));
    },

    async setChannels(input) {
      return outcome(await deps.repository.setChannels(input));
    },

    async setDirectMessages(input) {
      return outcome(await deps.repository.setDirectMessages(input));
    },

    async setTestAccess(input) {
      return outcome(await deps.repository.setTestAccess(input));
    },

    async setCallNames(input) {
      return outcome(await deps.repository.setCallNames(input));
    },

    async createServiceAccount(input) {
      const write = await deps.repository.bindServiceAccount({
        actorUserId: input.actorUserId,
        create: async (tx) => {
          const created = await deps.createServiceAccount(tx, { createdByUserId: input.actorUserId, displayName: DISCORD_SERVICE_ACCOUNT_NAME });
          return created.kind === "created" ? created : { kind: "actor_forbidden" };
        },
        expectedVersion: input.expectedVersion
      });
      if (write.kind === "ok" && write.created) await enableMcp(write.record);
      return outcome(write);
    },

    async setAssistant(input) {
      const write = await deps.repository.setAssistant({
        actorUserId: input.actorUserId,
        assistantId: input.assistantId,
        available: (tx, serviceUserId) => deps.isAssistantAvailable(tx, { assistantId: input.assistantId, userId: serviceUserId }),
        expectedVersion: input.expectedVersion
      });
      if (write.kind === "ok") await enableMcp(write.record);
      return outcome(write);
    },

    async setLimits(input) {
      return outcome(await deps.repository.setLimits(input));
    },

    async listGuilds() {
      const stored = await storedToken();
      if ("code" in stored) return { code: stored.code, ok: false };
      const guilds = await call(() => stored.client.listCurrentUserGuilds());
      if (!guilds.ok) return { code: guilds.failure ? discordTokenFailureCode(guilds.failure) : "discord_unreachable", ok: false };
      return {
        ok: true,
        state: { guilds: guilds.value.slice(0, 200).map((guild) => ({ id: guild.id, name: displayName(guild.name, guild.id) })) }
      };
    },

    async listChannels(guildId) {
      const stored = await storedToken();
      if ("code" in stored) return { code: stored.code, ok: false };
      const channels = await call(() => stored.client.listGuildChannels(guildId));
      if (!channels.ok) {
        // A server the bot is not in, or cannot see, answers like one that does not exist.
        if (channels.failure && (channels.failure.status === 403 || channels.failure.status === 404)) return { code: "not_found", ok: false };
        return { code: channels.failure ? discordTokenFailureCode(channels.failure) : "discord_unreachable", ok: false };
      }
      return {
        ok: true,
        state: {
          channels: channels.value.filter((channel) => !THREAD_TYPES.has(channel.type)).slice(0, 500).map((channel) => ({
            id: channel.id,
            kind: CHANNEL_KINDS[channel.type] ?? "other",
            name: displayName(channel.name, channel.id),
            parentId: channel.parent_id ?? null
          }))
        }
      };
    },

    async listAssistants() {
      const record = await deps.repository.read();
      if (!record.serviceUserId) return { code: "discord_service_account_missing", ok: false };
      const assistants = await deps.listAssistants(record.serviceUserId);
      return {
        ok: true,
        state: { assistants: assistants.slice(0, 500).map((assistant) => ({ id: assistant.id, name: assistant.name.slice(0, 200) || "Assistant" })) }
      };
    },

    async health() {
      const record = await deps.repository.read();
      const base = {
        connected: deps.connected() === true,
        enabled: record.enabled,
        lastConnectedAt: record.lastConnectedAt,
        lastFailureAt: record.lastFailureAt,
        lastFailureCode: record.lastFailureCode
      };
      // A bot that is off needs no attention, so its setup is not read.
      if (!record.enabled) return { ...base, setupReady: true };
      const at = now();
      if (!setupCache || setupCache.version !== record.version || setupCache.expiresAt <= at) {
        const entry = { check: setup(record).then(({ check }) => check), expiresAt: at + DISCORD_SETUP_CACHE_TTL_MS, version: record.version };
        setupCache = entry;
        entry.check.catch(() => { if (setupCache === entry) setupCache = null; });
      }
      const check = await setupCache.check;
      return { ...base, setupReady: check.ready };
    }
  });
}
