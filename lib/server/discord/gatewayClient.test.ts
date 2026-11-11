import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeDiscord, type FakeDiscord } from "@/tests/support/fakeDiscord";
import {
  createDiscordGatewayClient, DISCORD_GATEWAY_COMMANDS_PER_MINUTE, type DiscordDispatch, type DiscordGatewayOptions,
  type DiscordGatewaySession, type DiscordGatewayState
} from "./gatewayClient";
import { resolveDiscordNetwork } from "./transport";

const NETWORK = resolveDiscordNetwork({});

function harness(fake: FakeDiscord, overrides: Partial<DiscordGatewayOptions> = {}) {
  const dispatches: DiscordDispatch[] = [];
  const sessions: (DiscordGatewaySession | null)[] = [];
  const states: DiscordGatewayState[] = [];
  const beforeIdentify = vi.fn(async () => ({ ok: true as const, url: "wss://gateway.discord.gg" }));
  const client = createDiscordGatewayClient({
    token: () => fake.token, network: NETWORK, openSocket: (url) => fake.gateway.openSocket(url), beforeIdentify,
    onDispatch: (dispatch) => dispatches.push(dispatch), onSession: (session) => sessions.push(session),
    onState: (state) => states.push(state), random: () => 0.5, ...overrides
  });
  return { beforeIdentify, client, dispatches, sessions, states };
}

/** Lets queued microtasks (the in-memory sockets) run without moving the clock. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

afterEach(() => vi.useRealTimers());

describe("Discord gateway client against the in-memory fake", () => {
  it("identifies with intents 46593, shard [0,1] and no presence, then beats at interval × jitter and every interval", async () => {
    vi.useFakeTimers();
    const fake = createFakeDiscord({ heartbeatIntervalMs: 40_000 });
    const h = harness(fake);
    h.client.start();
    await settle();
    expect(h.beforeIdentify).toHaveBeenCalledOnce();
    const identify = fake.gateway.received().find((entry) => entry.op === 2)!;
    expect(identify.d).toEqual({ intents: 46593, shard: [0, 1], properties: { os: "linux", browser: "aiqsa", device: "aiqsa" }, tokenMatched: true });
    expect(h.client.state()).toEqual({ status: "ready" });
    expect(h.sessions).toEqual([expect.objectContaining({ sessionId: fake.gateway.sessionId(), resumeGatewayUrl: "wss://gateway-test.discord.gg/?v=10&encoding=json" })]);
    expect(h.dispatches.map((entry) => entry.type)).toEqual(["READY", "GUILD_CREATE"]);

    const beats = () => fake.gateway.received().filter((entry) => entry.op === 1);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(beats()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(beats()).toEqual([expect.objectContaining({ d: 2 })]);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(beats()).toHaveLength(2);
    expect(h.client.state().status).toBe("ready");
    h.client.stop();
  });

  it("treats a missing ACK as a zombie and resumes on the session's resume host", async () => {
    vi.useFakeTimers();
    const fake = createFakeDiscord({ heartbeatIntervalMs: 10_000 });
    const h = harness(fake);
    h.client.start();
    await settle();
    const sessionId = fake.gateway.sessionId();
    fake.gateway.withholdAcks(true);
    await vi.advanceTimersByTimeAsync(5_000);
    fake.gateway.dispatch("MESSAGE_CREATE", { id: "1100000000000000999", channel_id: fake.channels.text });
    await vi.advanceTimersByTimeAsync(10_000);
    fake.gateway.withholdAcks(false);
    // The reconnect is due at once; fake timers run a zero delay set inside a tick one millisecond later.
    await vi.advanceTimersByTimeAsync(1);
    const resume = fake.gateway.received().find((entry) => entry.op === 6)!;
    expect(resume.d).toEqual({ session_id: sessionId, seq: 3, tokenMatched: true });
    expect(fake.gateway.identifyCount()).toBe(1);
    expect(h.beforeIdentify).toHaveBeenCalledOnce();
    expect(fake.gateway.connections().at(-1)).toMatchObject({ host: "gateway-test.discord.gg", ready: true });
    expect(h.dispatches.map((entry) => entry.type)).toEqual(["READY", "GUILD_CREATE", "MESSAGE_CREATE", "RESUMED"]);
    expect(h.client.session()).toMatchObject({ sessionId, seq: 4 });
    h.client.stop();
  });

  it("resumes on op 7 and op 9 true, and identifies again only after op 9 false", async () => {
    vi.useFakeTimers();
    const fake = createFakeDiscord();
    const h = harness(fake);
    h.client.start();
    await settle();
    fake.gateway.reconnect();
    await settle();
    expect(fake.gateway.received().filter((entry) => entry.op === 6)).toHaveLength(1);
    fake.gateway.invalidateSession(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.gateway.received().filter((entry) => entry.op === 6)).toHaveLength(2);
    expect(fake.gateway.identifyCount()).toBe(1);
    fake.gateway.invalidateSession(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.sessions.at(-2)).toBeNull();
    expect(fake.gateway.identifyCount()).toBe(2);
    expect(h.beforeIdentify).toHaveBeenCalledTimes(2);
    expect(h.client.state().status).toBe("ready");
    h.client.stop();
  });

  it.each([
    [4004, "discord_token_rejected"], [4013, "discord_intents_disallowed"], [4014, "discord_intents_disallowed"],
    [4010, "discord_gateway_refused"], [4011, "discord_gateway_refused"], [4012, "discord_gateway_refused"]
  ])("stops for good on close %i with %s", async (code, health) => {
    vi.useFakeTimers();
    const fake = createFakeDiscord();
    const h = harness(fake);
    h.client.start();
    await settle();
    fake.gateway.close(code);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.client.state()).toEqual({ status: "stopped", code: health, closeCode: code });
    expect(fake.gateway.connections()).toHaveLength(1);
  });

  it("stops with discord_intents_disallowed when Message Content is off for the application", async () => {
    vi.useFakeTimers();
    const fake = createFakeDiscord({ messageContentEnabled: false });
    const h = harness(fake);
    h.client.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.client.state()).toMatchObject({ status: "stopped", code: "discord_intents_disallowed", closeCode: 4014 });
  });

  it("reconnects after a pause when the connection drops and resumes with the missed events replayed", async () => {
    vi.useFakeTimers();
    const fake = createFakeDiscord();
    const h = harness(fake);
    h.client.start();
    await settle();
    fake.gateway.drop();
    await settle();
    expect(h.client.state()).toMatchObject({ status: "waiting", code: "discord_disconnected" });
    // Missed while disconnected: Discord replays it after RESUME.
    fake.gateway.dispatch("MESSAGE_CREATE", { id: "1100000000000000999", channel_id: fake.channels.text });
    await vi.advanceTimersByTimeAsync(749);
    expect(fake.gateway.connections()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(fake.gateway.connections()).toHaveLength(2);
    expect(fake.gateway.received().filter((entry) => entry.op === 6)).toEqual([expect.objectContaining({ d: expect.objectContaining({ seq: 2 }) })]);
    expect(h.dispatches.map((entry) => entry.type)).toEqual(["READY", "GUILD_CREATE", "MESSAGE_CREATE", "RESUMED"]);
    expect(h.client.state().status).toBe("ready");
    h.client.stop();
  });

  it("waits when the IDENTIFY budget refuses and asks again later", async () => {
    vi.useFakeTimers();
    const fake = createFakeDiscord();
    const refusals = [{ ok: false as const, code: "discord_session_limit", retryAfterMs: 30_000 }];
    const h = harness(fake, {
      beforeIdentify: vi.fn(async () => refusals.shift() ?? { ok: true as const, url: "wss://gateway.discord.gg" })
    });
    h.client.start();
    await settle();
    expect(h.client.state()).toEqual({ status: "waiting", code: "discord_session_limit" });
    expect(fake.gateway.connections()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.client.state().status).toBe("ready");
    expect(fake.gateway.identifyCount()).toBe(1);
    h.client.stop();
  });

  it("refuses a gateway URL outside the allowlist without connecting", async () => {
    vi.useFakeTimers();
    const fake = createFakeDiscord();
    const h = harness(fake, { beforeIdentify: async () => ({ ok: true, url: "wss://gateway.example.com" }) });
    h.client.start();
    await settle();
    expect(h.client.state()).toMatchObject({ status: "stopped", code: "discord_gateway_url_invalid" });
    expect(fake.gateway.connections()).toHaveLength(0);
  });

  it("guards outgoing payloads at 4096 bytes and commands at 100 a minute, heartbeats excepted", async () => {
    vi.useFakeTimers();
    const fake = createFakeDiscord();
    const h = harness(fake);
    expect(h.client.send(3, {})).toEqual({ ok: false, code: "discord_gateway_not_open" });
    h.client.start();
    await settle();
    expect(h.client.send(3, { padding: "x".repeat(4_096) })).toEqual({ ok: false, code: "discord_gateway_payload_too_large" });
    let sent = 1; // IDENTIFY
    while (h.client.send(3, { since: null, activities: [], status: "online", afk: false }).ok) sent += 1;
    expect(sent).toBe(DISCORD_GATEWAY_COMMANDS_PER_MINUTE);
    expect(h.client.send(3, {})).toEqual({ ok: false, code: "discord_gateway_rate_limited" });
    expect(h.client.send(1, null)).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(60_001);
    expect(h.client.send(3, {}).ok).toBe(true);
    h.client.stop();
  });
});

describe("Discord gateway client over loopback WebSockets (undici)", () => {
  it("identifies on the main URL, resumes on the separate resume host after op 7 and receives replayed dispatches", async () => {
    const fake = createFakeDiscord({ heartbeatIntervalMs: 60_000 });
    const server = await fake.start();
    try {
      const network = resolveDiscordNetwork({ AIQSA_TEST_MODE: "1", NODE_ENV: "test", AIQSA_DISCORD_GATEWAY_URL: server.gatewayUrl });
      const dispatches: DiscordDispatch[] = [];
      const client = createDiscordGatewayClient({
        token: () => fake.token, network, beforeIdentify: async () => ({ ok: true, url: "wss://gateway.discord.gg" }),
        onDispatch: (dispatch) => dispatches.push(dispatch), random: () => 0.5
      });
      client.start();
      await vi.waitFor(() => expect(client.state().status).toBe("ready"), { timeout: 5_000 });
      expect(client.session()?.resumeGatewayUrl).toBe(`${server.resumeGatewayUrl}/?v=10&encoding=json`);
      fake.gateway.reconnect();
      await vi.waitFor(() => expect(dispatches.map((entry) => entry.type)).toContain("RESUMED"), { timeout: 5_000 });
      fake.postMessage({ channelId: fake.channels.text, authorId: fake.addUser({ username: "alice" }), content: "hello" });
      await vi.waitFor(() => expect(dispatches.at(-1)?.type).toBe("MESSAGE_CREATE"), { timeout: 5_000 });
      expect(fake.gateway.connections().map((entry) => entry.via)).toEqual(["main", "resume"]);
      expect(fake.gateway.identifyCount()).toBe(1);
      client.stop();
    } finally {
      await server.stop();
    }
  });
});
