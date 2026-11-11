import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeDiscord } from "@/tests/support/fakeDiscord";
import { captureRunObservation } from "@/tests/support/runObservation";
import { createDiscordRest } from "./rest";
import {
  createDiscordTransport, discordConnectLookup, discordGatewayUrl, DiscordTransportConfigError, isDiscordHostAllowed,
  openDiscordWebSocket, parseDiscordConnectAddress, resolveDiscordNetwork, type DiscordNetwork
} from "./transport";

/** A token-shaped sentinel: anything that echoes it fails the scans below. */
const SENTINEL = "SENTINELsentinelSENTINEL.SNTNL0.SENTINELsentinelSENTINELsentinel";
const TEST_ENV = { AIQSA_TEST_MODE: "1", NODE_ENV: "test" };
const EGRESS = "93.184.215.14";
const PUBLIC = [{ address: "93.184.215.34", family: 4 as const }];
const network = (overrides: Partial<DiscordNetwork> = {}): DiscordNetwork => ({
  testMode: false, apiOrigin: null, gatewayUrl: null, egress: null, ...overrides
});

function assertContentFree(value: unknown): void {
  const text = JSON.stringify(value, (_key, entry: unknown) => entry instanceof Error ? { message: entry.message, name: entry.name, code: (entry as { code?: unknown }).code } : entry);
  for (const forbidden of ["SENTINEL", "discord.com", "discordapp", "hm=", "/api/v10", "Bot "]) expect(text).not.toContain(forbidden);
}

function harness(options: Readonly<{ network?: DiscordNetwork; addresses?: readonly { address: string; family: 4 | 6 }[] }> = {}) {
  const attempts: { options: RequestOptions; outgoing: EventEmitter; socket: EventEmitter; respond: (status: number, body: string, headers?: Record<string, string>) => void }[] = [];
  const request = vi.fn((requestOptions: RequestOptions, callback: (incoming: IncomingMessage) => void) => {
    const outgoing = new EventEmitter();
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    attempts.push({
      options: requestOptions, outgoing, socket,
      respond: (status, body, headers = {}) => {
        const incoming = Object.assign(new EventEmitter(), { destroy: vi.fn(), headers, statusCode: status });
        callback(incoming as unknown as IncomingMessage);
        incoming.emit("data", Buffer.from(body));
        incoming.emit("end");
      }
    });
    queueMicrotask(() => outgoing.emit("socket", socket));
    return Object.assign(outgoing, { destroy: vi.fn(), end: vi.fn(), write: () => true }) as unknown as ClientRequest;
  });
  const resolve = vi.fn(async () => options.addresses ?? PUBLIC);
  const transport = createDiscordTransport({ network: options.network ?? network(), request, resolve });
  const ready = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };
  const connect = (index: number) => { attempts[index]!.socket.emit("connect"); attempts[index]!.socket.emit("secureConnect"); };
  return { attempts, connect, ready, request, resolve, transport };
}

afterEach(() => vi.useRealTimers());

describe("Discord host allowlist and egress address", () => {
  it("allows only Discord's REST, gateway and CDN hosts", () => {
    for (const host of ["discord.com", "gateway.discord.gg", "gateway-us-east1-b.discord.gg", "cdn.discordapp.com", "media.discordapp.net", "DISCORD.COM"]) {
      expect(isDiscordHostAllowed(host), host).toBe(true);
    }
    for (const host of ["example.com", "discord.com.example.com", "evil-discord.com", "discordapp.com", "discord.gg.example.com", "x.discordapp.net", "127.0.0.1", ""]) {
      expect(isDiscordHostAllowed(host), host).toBe(false);
    }
  });

  it("accepts one public IPv4 or IPv6 egress address and refuses anything else with its code", () => {
    expect(parseDiscordConnectAddress(undefined)).toBeNull();
    expect(parseDiscordConnectAddress("  ")).toBeNull();
    expect(parseDiscordConnectAddress(` ${EGRESS} `)).toEqual({ address: EGRESS, family: 4 });
    expect(parseDiscordConnectAddress("[2606:2800:21f:cb07:6820:80da:af6b:8b2c]")).toEqual({ address: "2606:2800:21f:cb07:6820:80da:af6b:8b2c", family: 6 });
    for (const value of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "fd00::1", "::1", "host.example.com", "93.184.215.14:443", "1.2.3"]) {
      expect(() => parseDiscordConnectAddress(value), value).toThrow(expect.objectContaining({ code: "discord_connect_address_invalid" }));
    }
    expect(() => resolveDiscordNetwork({ AIQSA_DISCORD_CONNECT_ADDRESS: "192.168.1.5" })).toThrow(DiscordTransportConfigError);
  });

  it("reads the loopback API and gateway overrides only in test mode", () => {
    const overrides = { AIQSA_DISCORD_API_ORIGIN: "http://127.0.0.1:9000", AIQSA_DISCORD_GATEWAY_URL: "ws://127.0.0.1:9001" };
    expect(resolveDiscordNetwork(overrides)).toMatchObject({ testMode: false, apiOrigin: null, gatewayUrl: null });
    expect(resolveDiscordNetwork({ ...overrides, AIQSA_TEST_MODE: "1", NODE_ENV: "production" })).toMatchObject({ apiOrigin: null });
    expect(resolveDiscordNetwork({ ...overrides, ...TEST_ENV }).apiOrigin?.origin).toBe("http://127.0.0.1:9000");
    for (const origin of ["http://10.0.0.5:9000", "https://discord.com", "http://127.0.0.1:9000/api"]) {
      expect(() => resolveDiscordNetwork({ ...TEST_ENV, AIQSA_DISCORD_API_ORIGIN: origin }), origin).toThrow(expect.objectContaining({ code: "discord_api_origin_invalid" }));
    }
  });
});

describe("pinned Discord REST and CDN transport", () => {
  it("sends the token only in the Authorization header to discord.com over a pinned, agentless connection", async () => {
    const h = harness();
    const call = h.transport.request({ token: SENTINEL, method: "GET", path: "/users/@me" });
    await h.ready();
    h.connect(0);
    expect(h.attempts[0]!.options).toMatchObject({
      agent: false, host: "discord.com", servername: "discord.com", port: 443, method: "GET", path: "/api/v10/users/@me",
      headers: expect.objectContaining({ authorization: `Bot ${SENTINEL}` })
    });
    h.attempts[0]!.respond(200, JSON.stringify({ id: "1", username: "bot" }), {
      "x-ratelimit-bucket": "b1", "x-ratelimit-remaining": "4", "x-ratelimit-reset-after": "1.5", "x-ratelimit-limit": "5"
    });
    await expect(call).resolves.toEqual({
      ok: true, status: 200, json: { id: "1", username: "bot" }, rateLimit: { bucket: "b1", limit: 5, remaining: 4, resetAfterMs: 1_500 }
    });
    expect(h.resolve).toHaveBeenCalledWith("discord.com");
  });

  it("connects every host to the egress address with the original SNI and Host, without DNS", async () => {
    const h = harness({ network: network({ egress: { address: EGRESS, family: 4 } }) });
    const call = h.transport.request({ token: SENTINEL, method: "GET", path: "/gateway/bot" });
    await h.ready();
    const options = h.attempts[0]!.options;
    expect(options).toMatchObject({ host: "discord.com", servername: "discord.com" });
    const looked = await new Promise<unknown[]>((resolve) => {
      (options.lookup as unknown as (host: string, opts: { all?: boolean }, callback: (...args: unknown[]) => void) => void)("discord.com", {}, (...args) => resolve(args));
    });
    expect(looked).toEqual([null, EGRESS, 4]);
    h.connect(0);
    h.attempts[0]!.respond(200, "{}");
    await call;
    const download = h.transport.download({ url: "https://cdn.discordapp.com/attachments/1/2/a.png?ex=1&is=2&hm=abc&" });
    await h.ready();
    expect(h.attempts[1]!.options).toMatchObject({ host: "cdn.discordapp.com", servername: "cdn.discordapp.com", path: "/attachments/1/2/a.png?ex=1&is=2&hm=abc&" });
    expect((h.attempts[1]!.options.headers as Record<string, string>).authorization).toBeUndefined();
    h.connect(1);
    h.attempts[1]!.respond(200, "PNG", { "content-type": "image/png" });
    await expect(download).resolves.toEqual({ ok: true, body: Buffer.from("PNG"), contentType: "image/png" });
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it.each([
    [[{ address: "10.0.0.8", family: 4 as const }]], [[{ address: "127.0.0.1", family: 4 as const }]],
    [[PUBLIC[0]!, { address: "fd00::1", family: 6 as const }]], [[]]
  ])("refuses DNS answers %j before connecting", async (addresses) => {
    const h = harness({ addresses });
    await expect(h.transport.request({ token: SENTINEL, method: "GET", path: "/users/@me" }))
      .resolves.toEqual({ ok: false, kind: "network_before_send", category: "forbidden_address" });
    expect(h.request).not.toHaveBeenCalled();
  });

  it("refuses redirects, foreign or plain-http CDN URLs and command or interaction routes", async () => {
    const h = harness();
    const call = h.transport.request({ token: SENTINEL, method: "GET", path: "/users/@me" });
    await h.ready();
    h.connect(0);
    h.attempts[0]!.respond(302, "", { location: "https://example.com/" });
    await expect(call).resolves.toEqual({ ok: false, kind: "redirect", status: 302 });
    for (const url of ["http://cdn.discordapp.com/a", "https://example.com/a.png", "https://user:pw@cdn.discordapp.com/a", "https://cdn.discordapp.com:8443/a", "not a url"]) {
      await expect(h.transport.download({ url }), url).resolves.toEqual({ ok: false, kind: "forbidden_host" });
    }
    for (const path of ["/applications/1/commands", "/applications/1/guilds/2/commands", "/interactions/1/t/callback", "/../x", "users/@me", "/users/@me?x=1"]) {
      await expect(h.transport.request({ token: SENTINEL, method: "POST", path }), path).rejects.toMatchObject({ code: "discord_request_invalid" });
    }
    await expect(h.transport.request({ token: "Bot x\r\nX-Evil: 1", method: "GET", path: "/users/@me" })).rejects.toMatchObject({ code: "discord_request_invalid" });
    expect(h.request).toHaveBeenCalledOnce();
  });

  it("keeps the token, URLs and CDN signatures out of every outcome, error and log record", async () => {
    const observation = await captureRunObservation();
    const h = harness();
    const rest = createDiscordRest({ transport: h.transport, token: () => SENTINEL, sleep: async () => undefined });
    const failing = rest.getCurrentUser();
    await h.ready();
    h.attempts[0]!.outgoing.emit("error", Object.assign(new Error(`PRIVATE ${SENTINEL} https://discord.com/api/v10/users/@me`), { code: "ECONNREFUSED" }));
    await h.ready();
    h.attempts[1]!.outgoing.emit("error", Object.assign(new Error(`PRIVATE ${SENTINEL}`), { code: "ECONNREFUSED" }));
    const refused = await failing;
    const answered = rest.getChannelMessage("1", "2");
    await h.ready();
    h.connect(2);
    h.attempts[2]!.respond(403, JSON.stringify({ code: 50013, message: `Missing ${SENTINEL} https://discord.com/x` }));
    const forbidden = await answered;
    const limited = rest.triggerTyping("1");
    await h.ready();
    h.connect(3);
    h.attempts[3]!.respond(429, JSON.stringify({ retry_after: 0.01, global: false, message: SENTINEL }), { "x-ratelimit-scope": "user" });
    await h.ready();
    h.connect(4);
    h.attempts[4]!.respond(429, JSON.stringify({ retry_after: 0.01, global: false, message: SENTINEL }), { "x-ratelimit-scope": "user" });
    const rateLimited = await limited;
    const cdn = await h.transport.download({ url: "https://example.com/attachments/1/2/a.png?hm=SENTINEL" });
    const thrown = await h.transport.request({ token: SENTINEL, method: "GET", path: "/applications/1/commands" }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ ok: false, code: "discord_network_before_send", delivery: "not_sent" });
    expect(forbidden).toMatchObject({ ok: false, code: "discord_api_error", status: 403, discordCode: 50013 });
    expect(rateLimited).toMatchObject({ ok: false, code: "discord_rate_limited" });
    assertContentFree([refused, forbidden, rateLimited, cdn, thrown, observation.records()]);
  });
});

describe("Discord transport over the loopback fake in test mode", () => {
  it("serves REST and the CDN from the loopback origin", async () => {
    const fake = createFakeDiscord();
    const server = await fake.start();
    try {
      const transport = createDiscordTransport({ env: { ...TEST_ENV, AIQSA_DISCORD_API_ORIGIN: server.origin } });
      const rest = createDiscordRest({ transport, token: () => fake.token });
      expect(await rest.getCurrentUser()).toMatchObject({ ok: true, value: { id: fake.bot.id } });
      const author = fake.addUser({ username: "carol" });
      const message = fake.postMessage({
        channelId: fake.channels.text, authorId: author, content: "see file",
        attachments: [{ filename: "notes.txt", data: Buffer.from("notes"), contentType: "text/plain" }]
      });
      const attachment = message.attachments[0]!;
      await expect(transport.download({ url: attachment.url })).resolves.toEqual({ ok: true, body: Buffer.from("notes"), contentType: "text/plain" });
      await expect(transport.download({ url: attachment.proxy_url })).resolves.toMatchObject({ ok: true });
      await expect(transport.download({ url: attachment.url, maxBytes: 2 })).resolves.toEqual({ ok: false, kind: "too_large", status: 200 });
      await expect(transport.download({ url: attachment.url.replace(/hm=[0-9a-f]+/u, "hm=00") })).resolves.toEqual({ ok: false, kind: "http", status: 404 });
      const created = await rest.createMessage(fake.channels.text, {
        content: "with file", files: [{ filename: "out.txt", contentType: "text/plain", data: Buffer.from("out") }]
      });
      expect(created.ok).toBe(true);
      expect(fake.messages(fake.channels.text).at(-1)).toMatchObject({ attachments: [expect.objectContaining({ filename: "out.txt", size: 3 })] });
    } finally {
      await server.stop();
    }
  });

  it("refuses the loopback origin outside test mode", () => {
    expect(resolveDiscordNetwork({ AIQSA_DISCORD_API_ORIGIN: "http://127.0.0.1:1" }).apiOrigin).toBeNull();
  });
});

describe("Discord gateway connection", () => {
  it("normalizes gateway URLs to v10 JSON and refuses others", () => {
    expect(discordGatewayUrl("wss://gateway.discord.gg", network())?.href).toBe("wss://gateway.discord.gg/?v=10&encoding=json");
    expect(discordGatewayUrl("wss://gateway-us-east1-b.discord.gg/?compress=zlib-stream", network())?.href)
      .toBe("wss://gateway-us-east1-b.discord.gg/?v=10&encoding=json");
    for (const url of ["ws://gateway.discord.gg", "wss://gateway.example.com", "wss://discord.com", "wss://gateway.discord.gg:8443", "ws://127.0.0.1:9000", "nope"]) {
      expect(discordGatewayUrl(url, network()), url).toBeNull();
    }
    expect(discordGatewayUrl("ws://localhost:9001", network({ testMode: true }))?.href).toBe("ws://localhost:9001/?v=10&encoding=json");
  });

  it("looks up gateway hosts at the egress address or at public DNS answers only", async () => {
    const lookup = (net: DiscordNetwork, host: string, resolve = vi.fn(async () => PUBLIC)) => new Promise<unknown[]>((done) => {
      discordConnectLookup(net, resolve)(host, { all: true }, (...args: unknown[]) => done(args));
    });
    expect(await lookup(network({ egress: { address: EGRESS, family: 4 } }), "gateway-test.discord.gg")).toEqual([null, [{ address: EGRESS, family: 4 }]]);
    expect(await lookup(network(), "gateway.discord.gg")).toEqual([null, [{ address: PUBLIC[0]!.address, family: 4 }]]);
    const [privateError] = await lookup(network(), "gateway.discord.gg", vi.fn(async () => [{ address: "10.1.1.1", family: 4 as const }]));
    expect(privateError).toMatchObject({ code: "ERR_DISCORD_ADDRESS_FORBIDDEN" });
    const [foreignError] = await lookup(network({ egress: { address: EGRESS, family: 4 } }), "example.com");
    expect(foreignError).toMatchObject({ code: "ERR_DISCORD_HOST_FORBIDDEN" });
    assertContentFree([privateError, foreignError]);
  });

  it("opens the WebSocket through its own dispatcher with the pinned lookup and a bounded frame size", () => {
    const agents: unknown[] = [];
    const sockets: { url: string; init: unknown }[] = [];
    const close = vi.fn(async () => undefined);
    class FakeAgent { constructor(options: unknown) { agents.push(options); } close = close; }
    const listeners: Record<string, (() => void)[]> = {};
    class FakeSocket {
      readyState = 0;
      constructor(url: string, init: unknown) { sockets.push({ url, init }); }
      send(): void {}
      close(): void {}
      addEventListener(type: string, listener: () => void): void { (listeners[type] ??= []).push(listener); }
    }
    const lookup = vi.fn();
    openDiscordWebSocket(new URL("wss://gateway.discord.gg/?v=10&encoding=json"), network(), {
      lookup, Agent: FakeAgent as never, WebSocket: FakeSocket as never
    });
    expect(agents).toEqual([{ connect: { lookup, timeout: 15_000 }, webSocket: { maxPayloadSize: 32 * 1024 * 1024 } }]);
    expect(sockets[0]!.url).toBe("wss://gateway.discord.gg/?v=10&encoding=json");
    expect((sockets[0]!.init as { dispatcher: unknown }).dispatcher).toBeInstanceOf(FakeAgent);
    listeners.close?.forEach((listener) => listener());
    expect(close).toHaveBeenCalledOnce();
  });
});
