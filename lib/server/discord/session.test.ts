import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeDiscord, type FakeDiscord } from "@/tests/support/fakeDiscord";
import type { DiscordHealthWrite, DiscordIdentifyReservation, DiscordPersistedSession } from "./control/repository";
import type { DiscordEffectiveControl } from "./control/state";
import type { DiscordIntakeDispatch } from "./intake";
import { createDiscordRest, type DiscordGatewayBot, type DiscordRestOutcome } from "./rest";
import { createDiscordSession, DISCORD_IDENTIFY_DAILY_LIMIT, type DiscordSessionDeps, type DiscordSessionStore } from "./session";
import { createDiscordTransport, resolveDiscordNetwork, type DiscordNetwork, type DiscordWebSocketLike } from "./transport";

const NETWORK = resolveDiscordNetwork({});

afterEach(() => vi.useRealTimers());

/** The control row's session, health and IDENTIFY times, in memory. */
function memoryStore() {
  const state = {
    health: [] as DiscordHealthWrite[],
    identifyAt: [] as Date[],
    progress: [] as Array<{ seq: number | null; sessionId: string }>,
    session: null as DiscordPersistedSession | null
  };
  const store: DiscordSessionStore = {
    async recordHealth(input) { state.health.push(input); },
    async saveSession({ generation, session }) { state.session = { ...session, generation }; },
    async forgetSession({ generation, sessionId }) {
      if (state.session?.generation === generation && state.session.sessionId === sessionId) state.session = null;
    },
    async saveProgress(input) {
      state.progress.push({ seq: input.seq, sessionId: input.sessionId });
      if (state.session?.sessionId === input.sessionId) state.session = { ...state.session, seq: input.seq };
    },
    async reserveIdentify({ limit, now, windowMs }): Promise<DiscordIdentifyReservation> {
      const recent = state.identifyAt.filter((at) => at.getTime() > now.getTime() - windowMs);
      if (recent.length >= limit) return { count: recent.length, ok: false, retryAt: new Date(recent[0]!.getTime() + windowMs) };
      state.identifyAt = [...recent, now];
      return { count: recent.length + 1, ok: true };
    }
  };
  return { state, store };
}

function controlFor(fake: FakeDiscord, state: ReturnType<typeof memoryStore>["state"], overrides: Partial<DiscordEffectiveControl> = {}): DiscordEffectiveControl {
  const generation = overrides.bot?.generation ?? 1;
  return {
    assistantId: null,
    bot: { applicationId: fake.application.id, generation, roleId: null, token: fake.token, userId: fake.bot.id, username: fake.bot.username },
    channelIds: new Set(),
    channelMode: "only_listed",
    dmEnabled: false,
    enabled: true,
    enabledAt: new Date(),
    guildId: fake.guild.id,
    limits: { parallelThreads: 16, perAuthorDaily: 100, perAuthorHourly: 20, perThreadHourly: 60 },
    serviceUserId: null,
    session: state.session && state.session.generation === generation
      ? { resumeGatewayUrl: state.session.resumeGatewayUrl, seq: state.session.seq, sessionId: state.session.sessionId }
      : null,
    testAuthorIds: new Set(),
    testChannelIds: new Set(),
    tokenState: "ready",
    version: 1,
    ...overrides
  };
}

function gatewayBot(remaining: () => number) {
  return vi.fn(async (): Promise<DiscordRestOutcome<DiscordGatewayBot>> => ({
    ok: true,
    value: { session_start_limit: { max_concurrency: 1, remaining: remaining(), reset_after: 3_600_000, total: 1000 }, shards: 1, url: "wss://gateway.discord.gg" }
  }));
}

/** A session on the in-memory gateway; `control` is re-read on every reevaluate. */
function harness(fake: FakeDiscord, overrides: Partial<DiscordSessionDeps> & { remaining?: () => number } = {}) {
  const memory = memoryStore();
  const dispatches: DiscordIntakeDispatch[] = [];
  let overridesOfControl: Partial<DiscordEffectiveControl> = {};
  const bot = gatewayBot(overrides.remaining ?? (() => 1000));
  const session = createDiscordSession({
    control: async () => controlFor(fake, memory.state, overridesOfControl),
    gatewayBot: bot,
    network: () => NETWORK,
    onDispatch: (dispatch) => { dispatches.push(dispatch); },
    openSocket: (url) => fake.gateway.openSocket(url),
    random: () => 0.5,
    store: memory.store,
    ...overrides
  });
  return {
    bot, dispatches, memory, session,
    setControl: (next: Partial<DiscordEffectiveControl>) => { overridesOfControl = next; }
  };
}

async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("Discord gateway session on the in-memory gateway", () => {
  it("identifies with intents 46593 and no presence, stores the session and its sequence at most every 5 s and on close", async () => {
    vi.useFakeTimers();
    const fake = createFakeDiscord();
    const h = harness(fake);
    await h.session.reevaluate();
    await settle();
    expect(h.session.connected()).toBe(true);
    expect(fake.gateway.received().find((entry) => entry.op === 2)?.d).toMatchObject({ intents: 46593, shard: [0, 1], tokenMatched: true });
    expect(fake.violations()).toEqual([]);
    expect(h.memory.state.session).toMatchObject({ generation: 1, sessionId: fake.gateway.sessionId(), resumeGatewayUrl: "wss://gateway-test.discord.gg/?v=10&encoding=json" });
    expect(h.memory.state.health).toEqual([expect.objectContaining({ connectedAt: expect.any(Date), failure: null, generation: 1 })]);
    expect(h.memory.state.identifyAt).toHaveLength(1);

    const alice = fake.addUser({ username: "alice" });
    for (const content of ["one", "two", "three"]) fake.postMessage({ authorId: alice, channelId: fake.channels.text, content });
    await settle();
    expect(h.dispatches.map((entry) => entry.type)).toEqual(["READY", "GUILD_CREATE", "MESSAGE_CREATE", "MESSAGE_CREATE", "MESSAGE_CREATE"]);
    expect(h.dispatches.every((entry) => entry.sessionId === fake.gateway.sessionId())).toBe(true);
    expect(h.memory.state.progress).toEqual([]);
    await settle(5_000);
    expect(h.memory.state.progress).toEqual([{ seq: 5, sessionId: fake.gateway.sessionId() }]);
    await settle(5_000);
    expect(h.memory.state.progress).toHaveLength(1);
    fake.postMessage({ authorId: alice, channelId: fake.channels.text, content: "four" });
    await settle();
    await h.session.stop();
    expect(h.memory.state.progress.at(-1)).toEqual({ seq: 6, sessionId: fake.gateway.sessionId() });
    expect(h.memory.state.session?.seq).toBe(6);
  });

  it("does not identify while Discord's remaining starts are below 200, waiting with discord_session_limit", async () => {
    vi.useFakeTimers();
    const fake = createFakeDiscord();
    let remaining = 199;
    const h = harness(fake, { remaining: () => remaining });
    await h.session.reevaluate();
    await settle();
    expect(fake.gateway.identifyCount()).toBe(0);
    expect(h.session.status()).toMatchObject({ code: "discord_session_limit", state: "waiting" });
    expect(h.memory.state.health).toEqual([expect.objectContaining({ failure: expect.objectContaining({ code: "discord_session_limit" }) })]);
    expect(h.memory.state.identifyAt).toEqual([]);
    // Discord's reset comes later; until then nothing identifies.
    remaining = 1000;
    await settle(3_600_000);
    expect(fake.gateway.identifyCount()).toBe(1);
    expect(h.session.connected()).toBe(true);
    await h.session.stop();
  });

  it("identifies at most 30 times in 24 hours, counted with the other processes'", async () => {
    vi.useFakeTimers();
    const fake = createFakeDiscord();
    const h = harness(fake);
    h.memory.state.identifyAt = Array.from({ length: DISCORD_IDENTIFY_DAILY_LIMIT }, (_, index) => new Date(Date.now() - 3_600_000 + index));
    await h.session.reevaluate();
    await settle();
    expect(fake.gateway.identifyCount()).toBe(0);
    expect(h.session.status()).toMatchObject({ code: "discord_session_limit", state: "waiting" });
    await settle(23 * 3_600_000 + 1_000);
    expect(fake.gateway.identifyCount()).toBe(1);
    await h.session.stop();
  });

  it("stops for good on 4014 with discord_intents_disallowed and tries again only after the control changed", async () => {
    vi.useFakeTimers();
    const fake = createFakeDiscord({ messageContentEnabled: false });
    const h = harness(fake);
    await h.session.reevaluate();
    await settle(120_000);
    expect(h.session.status()).toMatchObject({ code: "discord_intents_disallowed", state: "stopped" });
    expect(h.memory.state.health.at(-1)).toMatchObject({ failure: expect.objectContaining({ code: "discord_intents_disallowed" }) });
    await h.session.reevaluate();
    await settle(120_000);
    expect(fake.gateway.connections()).toHaveLength(1);
    fake.setMessageContentEnabled(true);
    h.setControl({ version: 2 });
    await h.session.reevaluate();
    await settle();
    expect(h.session.connected()).toBe(true);
    await h.session.stop();
  });

  it("stops and keeps the session when the bot is disabled, and refuses every REST send through the kill switch", async () => {
    vi.useFakeTimers();
    const fake = createFakeDiscord();
    const h = harness(fake);
    await h.session.reevaluate();
    await settle();
    expect(h.session.connected()).toBe(true);
    let enabled = true;
    const rest = createDiscordRest({ authorize: () => enabled, token: () => fake.token, transport: fake.transport });
    h.setControl({ enabled: false });
    enabled = false;
    await h.session.reevaluate();
    await settle();
    expect(h.session.status()).toEqual({ generation: null, state: "off" });
    expect(fake.gateway.connections().every((entry) => !entry.ready)).toBe(true);
    // Closed with a resumable code: the stored session survives for the next Enable.
    expect(h.memory.state.session?.sessionId).toBe(fake.gateway.sessionId());
    expect(await rest.createMessage(fake.channels.text, { content: "never" })).toEqual({ code: "discord_disabled", delivery: "not_sent", ok: false });
    expect(fake.calls({ route: "create_message" })).toEqual([]);

    h.setControl({ enabled: true, version: 3 });
    await h.session.reevaluate();
    await settle();
    expect(h.session.connected()).toBe(true);
    expect(fake.gateway.received().filter((entry) => entry.op === 6)).toHaveLength(1);
    expect(fake.gateway.identifyCount()).toBe(1);
    await h.session.stop();
  });

  it("replaces the session when the token changes, and records an invalid connect address without connecting", async () => {
    vi.useFakeTimers();
    const fake = createFakeDiscord();
    const h = harness(fake);
    await h.session.reevaluate();
    await settle();
    const first = fake.gateway.sessionId();
    h.setControl({ bot: { applicationId: fake.application.id, generation: 2, roleId: null, token: fake.token, userId: fake.bot.id, username: "aiqsa-test" } });
    await h.session.reevaluate();
    await settle();
    expect(h.session.status()).toMatchObject({ generation: 2, state: "ready" });
    expect(fake.gateway.identifyCount()).toBe(2);
    expect(fake.gateway.sessionId()).not.toBe(first);
    await h.session.stop();

    const broken = harness(fake, { network: () => { throw new Error("discord_connect_address_invalid"); } });
    await broken.session.reevaluate();
    await broken.session.reevaluate();
    expect(broken.session.status()).toEqual({ generation: null, state: "off" });
    expect(broken.memory.state.health).toEqual([expect.objectContaining({ failure: expect.objectContaining({ code: "discord_connect_address_invalid" }) })]);
  });

  it("records a lost connection once, keeping the time it began, and clears it on the next ready", async () => {
    vi.useFakeTimers();
    const fake = createFakeDiscord();
    const h = harness(fake);
    await h.session.reevaluate();
    await settle();
    fake.gateway.drop();
    await settle();
    expect(h.memory.state.health.at(-1)).toMatchObject({ failure: { code: "discord_disconnected", keepEarlier: true } });
    await settle(60_000);
    expect(h.session.connected()).toBe(true);
    expect(h.memory.state.health.at(-1)).toMatchObject({ connectedAt: expect.any(Date), failure: null });
    expect(h.memory.state.health.filter((entry) => entry.failure)).toHaveLength(1);
    await h.session.stop();
  });

  it("stops without another IDENTIFY when Discord rejects the token at /gateway/bot", async () => {
    vi.useFakeTimers();
    const fake = createFakeDiscord();
    const rejected = vi.fn(async (): Promise<DiscordRestOutcome<DiscordGatewayBot>> => ({ code: "discord_api_error", delivery: "refused", ok: false, status: 401 }));
    const h = harness(fake, { gatewayBot: rejected });
    await h.session.reevaluate();
    await settle(120_000);
    expect(rejected).toHaveBeenCalledOnce();
    expect(fake.gateway.connections()).toEqual([]);
    expect(h.memory.state.health).toEqual([expect.objectContaining({ failure: expect.objectContaining({ code: "discord_token_rejected" }) })]);
  });

  it("spends no IDENTIFY permit on connections that close before HELLO, however long they keep failing", async () => {
    vi.useFakeTimers();
    const fake = createFakeDiscord();
    let reachable = false;
    let opened = 0;
    // A WSS path that fails before HELLO (TLS, a misrouted SNI forwarder) while REST works.
    const deadSocket = (): DiscordWebSocketLike => {
      const closes: Array<(event: { code: number }) => void> = [];
      const socket = {
        readyState: 0,
        send() { throw new Error("not open"); },
        close() { socket.readyState = 3; },
        addEventListener(type: string, listener: (event: never) => void) { if (type === "close") closes.push(listener); }
      };
      queueMicrotask(() => { socket.readyState = 3; for (const listener of closes) listener({ code: 1006 }); });
      return socket as unknown as DiscordWebSocketLike;
    };
    const h = harness(fake, { openSocket: (url) => { opened += 1; return reachable ? fake.gateway.openSocket(url) : deadSocket(); } });
    await h.session.reevaluate();
    await settle(30 * 60_000);
    expect(opened).toBeGreaterThan(DISCORD_IDENTIFY_DAILY_LIMIT);
    expect(h.memory.state.identifyAt).toEqual([]);
    expect(h.bot.mock.calls.length).toBe(opened);
    expect(h.session.connected()).toBe(false);
    // Once the path works, the IDENTIFY Discord receives is the one permit spent.
    reachable = true;
    await settle(60_000);
    expect(h.session.connected()).toBe(true);
    expect(fake.gateway.identifyCount()).toBe(1);
    expect(h.memory.state.identifyAt).toHaveLength(1);
    await h.session.stop();
  });

  it("forgets only its own session, never a newer one another process stored", async () => {
    vi.useFakeTimers();
    const fake = createFakeDiscord();
    const h = harness(fake);
    await h.session.reevaluate();
    await settle();
    const newer: DiscordPersistedSession = { generation: 1, resumeGatewayUrl: "wss://gateway-test.discord.gg/?v=10&encoding=json", seq: 4, sessionId: "newer" };
    h.memory.state.session = newer;
    fake.gateway.invalidateSession(false);
    await settle();
    expect(h.memory.state.session).toEqual(newer);

    const own = harness(fake);
    await own.session.reevaluate();
    await settle();
    expect(own.memory.state.session?.sessionId).toBe(fake.gateway.sessionId());
    fake.gateway.invalidateSession(false);
    await settle();
    expect(own.memory.state.session).toBeNull();
    await h.session.stop();
    await own.session.stop();
  });
});

describe("Discord gateway session over loopback (restart and deploy)", () => {
  it("resumes the stored session in a new process instead of identifying, and receives the events it missed", async () => {
    const fake = createFakeDiscord({ heartbeatIntervalMs: 60_000 });
    const server = await fake.start();
    try {
      const env = { AIQSA_DISCORD_API_ORIGIN: server.origin, AIQSA_DISCORD_GATEWAY_URL: server.gatewayUrl, AIQSA_TEST_MODE: "1", NODE_ENV: "test" };
      const network: DiscordNetwork = resolveDiscordNetwork(env);
      const transport = createDiscordTransport({ network });
      const memory = memoryStore();
      const start = () => {
        const dispatches: DiscordIntakeDispatch[] = [];
        const session = createDiscordSession({
          control: async () => controlFor(fake, memory.state),
          gatewayBot: (token) => createDiscordRest({ token: () => token, transport }).getGatewayBot(),
          network: () => network,
          onDispatch: (dispatch) => { dispatches.push(dispatch); },
          random: () => 0.5,
          store: memory.store
        });
        return { dispatches, session };
      };
      const first = start();
      await first.session.reevaluate();
      await vi.waitFor(() => expect(first.session.connected()).toBe(true), { timeout: 5_000 });
      await vi.waitFor(() => expect(memory.state.session).not.toBeNull(), { timeout: 5_000 });
      const alice = fake.addUser({ username: "alice" });
      fake.postMessage({ authorId: alice, channelId: fake.channels.text, content: "before" });
      await vi.waitFor(() => expect(first.dispatches.at(-1)?.type).toBe("MESSAGE_CREATE"), { timeout: 5_000 });
      // The old container goes away (its stop saves the sequence); a message arrives in between.
      await first.session.stop();
      const missed = fake.postMessage({ authorId: alice, channelId: fake.channels.text, content: "missed" });

      const second = start();
      await second.session.reevaluate();
      await vi.waitFor(() => expect(second.dispatches.map((entry) => entry.type)).toEqual(["MESSAGE_CREATE", "RESUMED"]), { timeout: 5_000 });
      expect((second.dispatches[0]!.data as { id: string }).id).toBe(missed.id);
      expect(fake.gateway.identifyCount()).toBe(1);
      expect(fake.gateway.received().filter((entry) => entry.op === 6)).toEqual([
        expect.objectContaining({ d: { seq: memory.state.progress.at(-1)?.seq, session_id: memory.state.session?.sessionId, tokenMatched: true } })
      ]);
      expect(fake.calls({ route: "get_gateway_bot" })).toHaveLength(1);
      // The RESUME spent no permit: only the first IDENTIFY did.
      expect(memory.state.identifyAt).toHaveLength(1);
      expect(fake.gateway.connections().map((entry) => entry.via)).toEqual(["main", "resume"]);
      expect(fake.violations()).toEqual([]);
      await second.session.stop();
    } finally {
      await server.stop();
    }
  });
});
