import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createFakeDiscord, FAKE_DISCORD_CHANNEL_TYPES, type FakeDiscord } from "@/tests/support/fakeDiscord";
import { DISCORD_LIMIT_DEFAULTS, decodeDiscordAdminState } from "../../../contracts/discord";
import { createDiscordRest } from "../rest";
import { createDiscordControlHooks } from "./hooks";
import type { DiscordControlRecord, DiscordControlRepository, DiscordControlWrite } from "./repository";
import { createDiscordControlService, type DiscordControlServiceDeps } from "./service";
import type { DiscordAssistantSetupFacts, DiscordSetupSources } from "./setup";
import { createDiscordControlCache, effectiveDiscordControl } from "./state";
import { decryptDiscordBotToken } from "./tokenEnvelope";

const TX = {} as Prisma.TransactionClient;

function blank(): DiscordControlRecord {
  return {
    applicationId: null, assistantId: null, botRoleId: null, botUserId: null, botUsername: null, channelIds: [], channelMode: "only_listed",
    dmEnabled: false, enabled: false, enabledAt: null, guildId: null, guildName: null, identifyAt: [], lastConnectedAt: null, lastEventAt: null,
    lastFailureAt: null, lastFailureCode: null, limits: { ...DISCORD_LIMIT_DEFAULTS }, serviceUserId: null, session: null, testAuthorIds: [],
    testChannelIds: [], tokenEnvelope: null, tokenGeneration: 0, version: 1
  };
}

/** The repository's locking and version rules over one in-memory row. */
function memoryRepository(seed: Partial<DiscordControlRecord> = {}) {
  let row: DiscordControlRecord = { ...blank(), ...seed };
  const write = async (expectedVersion: number, work: (current: DiscordControlRecord) => Promise<DiscordControlWrite | Partial<DiscordControlRecord>>) => {
    if (row.version !== expectedVersion) return { kind: "stale" } as const;
    const result = await work(row);
    if ("kind" in result) return result as DiscordControlWrite;
    row = { ...row, ...result, version: row.version + 1 };
    return { kind: "ok", record: row } as const;
  };
  const repository: DiscordControlRepository = {
    read: async () => row,
    saveToken: (input) => write(input.expectedVersion, async (current) => ({
      applicationId: input.applicationId, botUserId: input.botUserId, botUsername: input.botUsername, lastFailureAt: null, lastFailureCode: null,
      session: null, tokenEnvelope: input.seal(current.tokenGeneration + 1), tokenGeneration: current.tokenGeneration + 1
    })),
    setEnabled: (input) => write(input.expectedVersion, async (current) => input.enabled && !current.tokenEnvelope
      ? { kind: "token_missing" } as const : { enabled: input.enabled, ...(input.enabled && !current.enabled ? { enabledAt: input.now } : {}) }),
    setGuild: (input) => write(input.expectedVersion, async (current) => ({
      guildId: input.guildId, guildName: input.guildName, ...(current.guildId === input.guildId ? {} : { channelIds: [], testChannelIds: [] })
    })),
    setChannels: (input) => write(input.expectedVersion, async () => ({ channelIds: [...input.channelIds], channelMode: input.channelMode })),
    setDirectMessages: (input) => write(input.expectedVersion, async () => ({ dmEnabled: input.dmEnabled })),
    setTestAccess: (input) => write(input.expectedVersion, async () => ({ testAuthorIds: [...input.testAuthorIds], testChannelIds: [...input.testChannelIds] })),
    async bindServiceAccount(input) {
      let created = false;
      const result = await write(input.expectedVersion, async (current) => {
        if (current.serviceUserId) return { kind: "ok", record: current } as const;
        const account = await input.create(TX);
        if (account.kind !== "created") return { kind: "actor_forbidden" } as const;
        created = true;
        return { serviceUserId: account.userId };
      });
      return result.kind === "ok" ? { ...result, created } : result;
    },
    setAssistant: (input) => write(input.expectedVersion, async (current) => {
      if (!current.serviceUserId) return { kind: "service_account_missing" } as const;
      if (!await input.available(TX, current.serviceUserId)) return { kind: "assistant_unavailable" } as const;
      return { assistantId: input.assistantId };
    }),
    setLimits: (input) => write(input.expectedVersion, async () => ({ limits: input.limits })),
    recordHealth: async () => undefined,
    saveSession: async () => undefined,
    forgetSession: async () => undefined,
    saveProgress: async () => undefined,
    reserveIdentify: async () => ({ count: 1, ok: true }),
    recordBotRole: async () => undefined
  };
  return { current: () => row, repository };
}

const AVAILABLE: DiscordAssistantSetupFacts = { credential: "own", mcp: "granted", mcpToolCount: 12, model: "ok", search: "on", state: "available" };

function harness(fake: FakeDiscord, seed: Partial<DiscordControlRecord> = {}, overrides: Partial<DiscordControlServiceDeps> = {}) {
  const key = randomBytes(32);
  const memory = memoryRepository(seed);
  const hooks = createDiscordControlHooks();
  const changed = vi.fn();
  hooks.onChange(changed);
  const cache = createDiscordControlCache({ load: async () => effectiveDiscordControl(await memory.repository.read(), () => key) });
  let assistantFacts: DiscordAssistantSetupFacts = AVAILABLE;
  let budget = false;
  const sources: DiscordSetupSources = {
    assistant: vi.fn(async () => assistantFacts),
    monthlyBudget: vi.fn(async () => budget),
    serviceAccount: vi.fn(async (userId: string) => userId === "svc_discord" ? { status: "active" as const } : null)
  };
  const deps = {
    assistantName: vi.fn(async () => "Discord agent"),
    cache,
    connected: () => true,
    createRest: (token: string) => createDiscordRest({ token: () => token, transport: fake.transport }),
    createServiceAccount: vi.fn(async () => ({ kind: "created" as const, userId: "svc_discord" })),
    enableMcpServers: vi.fn(async () => undefined),
    encryptionKey: () => key,
    hooks,
    isAssistantAvailable: vi.fn(async () => true),
    listAssistants: vi.fn(async () => [{ id: "asst_1", name: "Discord agent" }]),
    repository: memory.repository,
    setupSources: sources,
    ...overrides
  };
  const service = createDiscordControlService(deps);
  return {
    changed, deps, key, memory, service, sources,
    setAssistantFacts: (next: DiscordAssistantSetupFacts) => { assistantFacts = next; },
    setBudget: (next: boolean) => { budget = next; }
  };
}

const actor = (expectedVersion: number) => ({ actorUserId: "admin_1", expectedVersion });

describe("Discord control service", () => {
  it("Test & Save stores a token Discord proved, with the bot's identity, and never answers the token", async () => {
    const fake = createFakeDiscord();
    const h = harness(fake);
    const result = await h.service.testAndSave({ ...actor(1), token: fake.token });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(decodeDiscordAdminState(result.state)).toEqual(result.state);
    expect(result.state).toMatchObject({
      bot: { applicationId: fake.application.id, userId: fake.bot.id, username: "aiqsa-test" }, enabled: false, tokenConfigured: true, version: 2
    });
    expect(JSON.stringify(result.state)).not.toContain(fake.token);
    const stored = h.memory.current();
    expect(decryptDiscordBotToken({ envelope: stored.tokenEnvelope!, generation: 1, key: h.key })).toBe(fake.token);
    expect(fake.calls().map((call) => call.route).sort()).toEqual(["get_current_application", "get_current_user"]);
    expect(h.changed).toHaveBeenCalledOnce();
  });

  it("refuses a token Discord rejects, a stale version and an application without Message Content, storing nothing", async () => {
    const fake = createFakeDiscord();
    const h = harness(fake);
    const wrong = `${"A".repeat(24)}.${"b".repeat(6)}.${"c".repeat(27)}`;
    expect(await h.service.testAndSave({ ...actor(1), token: wrong })).toEqual({ code: "discord_token_rejected", ok: false });
    expect(await h.service.testAndSave({ ...actor(4), token: fake.token })).toEqual({ code: "discord_control_stale", ok: false });
    fake.setMessageContentEnabled(false);
    expect(await h.service.testAndSave({ ...actor(1), token: fake.token })).toEqual({ code: "discord_message_content_disabled", ok: false });
    expect(h.memory.current()).toMatchObject({ tokenEnvelope: null, version: 1 });
    expect(h.changed).not.toHaveBeenCalled();
  });

  it("refuses Enable while a blocking setup item fails and enables once every one passes", async () => {
    const fake = createFakeDiscord();
    const h = harness(fake);
    await h.service.testAndSave({ ...actor(1), token: fake.token });
    expect(await h.service.enable(actor(2))).toEqual({ code: "discord_setup_incomplete", ok: false });
    expect((await h.service.setGuild({ ...actor(2), guildId: "1100000000000009999" }))).toEqual({ code: "discord_guild_missing", ok: false });
    const guild = await h.service.setGuild({ ...actor(2), guildId: fake.guild.id });
    expect(guild.ok && guild.state.guild).toEqual({ id: fake.guild.id, name: "Example server" });
    const account = await h.service.createServiceAccount(actor(3));
    expect(account.ok && account.state.serviceAccount).toEqual({ status: "active", userId: "svc_discord" });
    expect(await h.service.createServiceAccount(actor(4))).toMatchObject({ ok: true, state: { version: 4 } });
    expect(h.deps.createServiceAccount).toHaveBeenCalledOnce();
    expect(await h.service.enable(actor(4))).toEqual({ code: "discord_setup_incomplete", ok: false });
    const assistant = await h.service.setAssistant({ ...actor(4), assistantId: "asst_1" });
    expect(assistant.ok && assistant.state.assistant).toEqual({ id: "asst_1", name: "Discord agent" });
    expect(h.deps.enableMcpServers).toHaveBeenCalledWith({ assistantId: "asst_1", serviceUserId: "svc_discord" });
    const enabled = await h.service.enable(actor(5));
    expect(enabled.ok && enabled.state).toMatchObject({ enabled: true, setup: { ready: true }, version: 6 });
    expect(h.memory.current().enabledAt).toBeInstanceOf(Date);
    const disabled = await h.service.disable(actor(6));
    expect(disabled.ok && disabled.state.enabled).toBe(false);
  });

  it("reports every setup item with its action, warning about the shared key and a monthly budget", async () => {
    const fake = createFakeDiscord();
    const h = harness(fake);
    await h.service.testAndSave({ ...actor(1), token: fake.token });
    let state = await h.service.read();
    expect(state.setup.items.map((item) => [item.code, item.status, item.action])).toEqual([
      ["discord_token_missing", "ok", null],
      ["discord_token_rejected", "ok", null],
      ["discord_message_content_disabled", "ok", null],
      ["discord_guild_missing", "blocking", "select_guild"],
      ["discord_service_account_missing", "blocking", "create_service_account"],
      ["discord_assistant_missing", "blocking", "select_assistant"]
    ]);
    await h.service.setGuild({ ...actor(2), guildId: fake.guild.id });
    await h.service.createServiceAccount(actor(3));
    await h.service.setAssistant({ ...actor(4), assistantId: "asst_1" });
    h.setAssistantFacts({ ...AVAILABLE, credential: "shared", search: "off" });
    h.setBudget(true);
    state = await h.service.read();
    expect(state.setup.ready).toBe(true);
    expect(state.setup.items.filter((item) => item.status !== "ok").map((item) => [item.code, item.status, item.action])).toEqual([
      ["discord_search_disabled", "warning", "open_assistant"],
      ["discord_shared_key", "warning", "open_provider_keys"],
      ["discord_monthly_budget", "warning", "open_usage_limits"]
    ]);
    h.setAssistantFacts({ ...AVAILABLE, mcp: "not_granted" });
    state = await h.service.read();
    expect(state.setup).toMatchObject({ ready: false });
    expect(state.setup.items.find((item) => item.status === "blocking")).toEqual({ action: "open_mcp_grants", code: "discord_mcp_not_granted", status: "blocking" });
    // An exact MCP row whose one server publishes 157 tools: admission would refuse every question.
    h.setAssistantFacts({ ...AVAILABLE, mcpToolCount: 157 });
    state = await h.service.read();
    expect(state.setup).toMatchObject({ ready: false });
    expect(state.setup.items.filter((item) => item.status === "blocking")).toEqual([
      { action: "open_assistant", code: "discord_mcp_too_many_tools", status: "blocking", toolCount: 157 }
    ]);
    h.setAssistantFacts({ ...AVAILABLE, mcpToolCount: 100 });
    expect((await h.service.read()).setup.ready).toBe(true);
    h.setAssistantFacts({ ...AVAILABLE, mcp: "none", mcpToolCount: 0 });
    expect((await h.service.read()).setup.items.map((item) => item.code)).not.toContain("discord_mcp_too_many_tools");
  });

  it("names stored channels from Discord for display, keeping ids Discord no longer shows", async () => {
    const fake = createFakeDiscord();
    const h = harness(fake);
    await h.service.testAndSave({ ...actor(1), token: fake.token });
    await h.service.setGuild({ ...actor(2), guildId: fake.guild.id });
    const result = await h.service.setChannels({ ...actor(3), channelIds: [fake.channels.text, "1100000000000009998"], channelMode: "all_except" });
    expect(result.ok && result.state).toMatchObject({
      channelMode: "all_except", channels: [{ id: fake.channels.text, name: "agent-test" }, { id: "1100000000000009998", name: null }]
    });
    await h.service.read();
    // Names are kept a minute per token and server.
    expect(fake.calls({ route: "list_guild_channels" })).toHaveLength(1);
  });

  it("lists the bot's servers, a server's channels without threads, and the Assistants the service account can use", async () => {
    const fake = createFakeDiscord();
    const h = harness(fake);
    expect(await h.service.listGuilds()).toEqual({ code: "discord_token_missing", ok: false });
    await h.service.testAndSave({ ...actor(1), token: fake.token });
    fake.addChannel({ name: "a thread", parentId: fake.channels.text, type: FAKE_DISCORD_CHANNEL_TYPES.publicThread });
    expect(await h.service.listGuilds()).toEqual({ ok: true, state: { guilds: [{ id: fake.guild.id, name: "Example server" }] } });
    const channels = await h.service.listChannels(fake.guild.id);
    expect(channels.ok && channels.state.channels.map((channel) => [channel.name, channel.kind])).toEqual([
      ["agent-test", "text"], ["announcements", "announcement"], ["questions", "forum"], ["voice-room", "voice"]
    ]);
    expect(await h.service.listChannels("1100000000000009999")).toEqual({ code: "not_found", ok: false });
    expect(await h.service.listAssistants()).toEqual({ code: "discord_service_account_missing", ok: false });
    await h.service.createServiceAccount(actor(2));
    expect(await h.service.listAssistants()).toEqual({ ok: true, state: { assistants: [{ id: "asst_1", name: "Discord agent" }] } });
    expect(h.deps.listAssistants).toHaveBeenCalledWith("svc_discord");
  });

  it("refuses an Assistant the service account cannot use, and one before the service account exists", async () => {
    const fake = createFakeDiscord();
    const h = harness(fake, {}, { isAssistantAvailable: vi.fn(async () => false) });
    expect(await h.service.setAssistant({ ...actor(1), assistantId: "asst_1" })).toEqual({ code: "discord_service_account_missing", ok: false });
    await h.service.createServiceAccount(actor(1));
    expect(await h.service.setAssistant({ ...actor(2), assistantId: "asst_1" })).toEqual({ code: "discord_assistant_unavailable", ok: false });
    expect(h.deps.enableMcpServers).not.toHaveBeenCalled();
  });

  it("answers the attention rules without reading setup while the bot is off, and caches setup per version while on", async () => {
    const fake = createFakeDiscord();
    const h = harness(fake, { lastFailureAt: new Date("2026-11-12T09:00:00.000Z"), lastFailureCode: "discord_disconnected" });
    expect(await h.service.health()).toMatchObject({ enabled: false, lastFailureCode: "discord_disconnected", setupReady: true });
    expect(h.sources.serviceAccount).not.toHaveBeenCalled();
    const on = harness(fake, { enabled: true, enabledAt: new Date(), tokenEnvelope: null });
    expect(await on.service.health()).toMatchObject({ enabled: true, setupReady: false });
    await on.service.health();
    expect(on.sources.monthlyBudget).not.toHaveBeenCalled();
  });
});
