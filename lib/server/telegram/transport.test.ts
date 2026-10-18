import { EventEmitter } from "node:events";
import { createServer, type ClientRequest, type IncomingMessage, type RequestOptions, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTelegramTransport, resolveTelegramApiOrigin, telegramOutcomeFromResponse, TELEGRAM_DOWNLOAD_MAX_BYTES,
  TELEGRAM_JSON_RESPONSE_MAX_BYTES, TelegramTransportConfigError
} from "./transport";

const TOKEN = "987654321:SENTINELtokenSENTINELtokenSENTINEL_x";
const TEST_ENV = { AIQSA_TEST_MODE: "1", NODE_ENV: "test" };
const PUBLIC = [{ address: "149.154.167.220", family: 4 as const }, { address: "2001:67c:4e8:f004::9", family: 6 as const }];
const failure = (code: string) => Object.assign(new Error(`PRIVATE ${TOKEN} https://api.telegram.org/bot${TOKEN}/getMe`), { code });

function harness(options: { addresses?: typeof PUBLIC } = {}) {
  const attempts: Array<{
    options: RequestOptions; outgoing: EventEmitter; socket: EventEmitter; written: Buffer[];
    end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>;
    respond: (status: number, headers?: Record<string, string>) => EventEmitter;
  }> = [];
  const factory = vi.fn((requestOptions: RequestOptions, callback: (incoming: IncomingMessage) => void) => {
    const outgoing = new EventEmitter();
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const written: Buffer[] = [];
    const end = vi.fn((chunk?: Buffer) => { if (chunk) written.push(chunk); });
    const destroy = vi.fn();
    attempts.push({
      destroy, end, options: requestOptions, outgoing, socket, written,
      respond: (status, headers = {}) => {
        const incoming = Object.assign(new EventEmitter(), { destroy: vi.fn(), headers, statusCode: status });
        callback(incoming as unknown as IncomingMessage);
        return incoming;
      }
    });
    queueMicrotask(() => outgoing.emit("socket", socket));
    return Object.assign(outgoing, { destroy, end, write: (chunk: Buffer) => { written.push(chunk); return true; } }) as unknown as ClientRequest;
  });
  const resolve = vi.fn(async () => options.addresses ?? PUBLIC);
  const transport = createTelegramTransport({ request: factory, resolve, env: {} });
  const ready = async () => { for (let index = 0; index < 6; index += 1) await Promise.resolve(); };
  const connect = (index: number) => {
    attempts[index]!.socket.emit("connect");
    attempts[index]!.socket.emit("secureConnect");
  };
  const reply = (index: number, status: number, body: unknown) => {
    const incoming = attempts[index]!.respond(status);
    incoming.emit("data", Buffer.from(typeof body === "string" ? body : JSON.stringify(body)));
    incoming.emit("end");
  };
  return { attempts, connect, factory, reply, ready, resolve, transport };
}

function assertNoSecrets(value: unknown): void {
  const text = JSON.stringify(value, (_key, entry: unknown) => entry instanceof Error ? { message: entry.message, name: entry.name } : entry);
  expect(text).not.toContain("SENTINEL");
  expect(text).not.toContain("api.telegram.org");
  expect(text).not.toContain("/bot");
}

afterEach(() => vi.useRealTimers());

describe("Telegram API origin", () => {
  it("uses Telegram over HTTPS and reads the override only in test mode", () => {
    expect(resolveTelegramApiOrigin({ env: {} }).url.origin).toBe("https://api.telegram.org");
    const override = { AIQSA_TELEGRAM_API_ORIGIN: "http://127.0.0.1:8123" };
    expect(resolveTelegramApiOrigin({ env: override }).url.origin).toBe("https://api.telegram.org");
    expect(resolveTelegramApiOrigin({ env: { ...override, AIQSA_TEST_MODE: "1", NODE_ENV: "production" } }).url.origin)
      .toBe("https://api.telegram.org");
    expect(resolveTelegramApiOrigin({ env: { ...override, ...TEST_ENV } })).toMatchObject({ loopback: true });
    expect(resolveTelegramApiOrigin({ env: { ...override, ...TEST_ENV } }).url.origin).toBe("http://127.0.0.1:8123");
  });

  it.each([
    ["http://api.telegram.org", {}], ["http://127.0.0.1:8123", {}], ["https://127.0.0.1:8123", {}],
    ["http://10.0.0.5:8123", TEST_ENV], ["https://api.telegram.org/bot", {}], ["https://user:pw@api.telegram.org", {}],
    ["ftp://127.0.0.1:21", TEST_ENV], ["not a url", {}]
  ])("refuses the origin %s with a content-free error", (origin, env) => {
    const error = (() => { try { resolveTelegramApiOrigin({ origin, env }); } catch (caught) { return caught; } })();
    expect(error).toBeInstanceOf(TelegramTransportConfigError);
    expect(error).toMatchObject({ code: "telegram_api_origin_invalid", message: "telegram_api_origin_invalid" });
  });
});

describe("Telegram response mapping", () => {
  it("separates results, Telegram refusals with retry_after and other HTTP answers", () => {
    expect(telegramOutcomeFromResponse(200, JSON.stringify({ ok: true, result: [1] }))).toEqual({ ok: true, result: [1] });
    expect(telegramOutcomeFromResponse(429, JSON.stringify({
      ok: false, error_code: 429, description: "Too Many Requests: retry after 7", parameters: { retry_after: 7 }
    }))).toEqual({ ok: false, kind: "telegram", status: 429, errorCode: 429, retryAfter: 7, description: "Too Many Requests: retry after 7" });
    expect(telegramOutcomeFromResponse(502, "<html>")).toEqual({ ok: false, kind: "http", status: 502 });
    expect(telegramOutcomeFromResponse(200, "{}")).toEqual({ ok: false, kind: "http", status: 200, category: "invalid_response" });
    const long = telegramOutcomeFromResponse(400, JSON.stringify({ ok: false, error_code: 400, description: "x".repeat(5_000) }));
    expect(long.ok === false && long.description?.length).toBe(512);
  });
});

describe("pinned Telegram transport", () => {
  it.each([
    [[{ address: "10.0.0.8", family: 4 as const }]], [[{ address: "127.0.0.1", family: 4 as const }]],
    [[{ address: "169.254.169.254", family: 4 as const }]], [[{ address: "fd00::1", family: 6 as const }]],
    [[PUBLIC[0]!, { address: "192.168.0.2", family: 4 as const }]], [[]]
  ])("refuses addresses %j before connecting", async (addresses) => {
    const h = harness({ addresses: addresses as typeof PUBLIC });
    const outcome = await h.transport.call({ token: TOKEN, method: "getMe" });
    expect(outcome).toEqual({ ok: false, kind: "network_before_send", category: "forbidden_address" });
    expect(h.factory).not.toHaveBeenCalled();
  });

  it("posts JSON to the method path over a pinned, agentless connection and returns the result", async () => {
    const h = harness();
    const call = h.transport.call({ token: TOKEN, method: "sendMessage", params: { chat_id: 5, text: "hi" } });
    await h.ready();
    h.connect(0);
    expect(h.attempts[0]!.options).toMatchObject({
      agent: false, host: "api.telegram.org", method: "POST", path: `/bot${TOKEN}/sendMessage`, port: 443, servername: "api.telegram.org"
    });
    expect(Buffer.concat(h.attempts[0]!.written).toString()).toBe(JSON.stringify({ chat_id: 5, text: "hi" }));
    h.reply(0, 200, { ok: true, result: { message_id: 1 } });
    await expect(call).resolves.toEqual({ ok: true, result: { message_id: 1 } });
    expect(h.resolve).toHaveBeenCalledOnce();
  });

  it("tries the next address only before sending and reports a content-free category", async () => {
    const h = harness();
    const call = h.transport.call({ token: TOKEN, method: "getMe" });
    await h.ready();
    h.attempts[0]!.outgoing.emit("error", failure("ECONNREFUSED"));
    await h.ready();
    expect(h.attempts).toHaveLength(2);
    h.attempts[1]!.outgoing.emit("error", failure("ECONNREFUSED"));
    const outcome = await call;
    expect(outcome).toEqual({ ok: false, kind: "network_before_send", category: "connect" });
    assertNoSecrets(outcome);
  });

  it("calls a TLS failure network_before_send and anything after writing network_after_send", async () => {
    const tls = harness();
    const tlsCall = tls.transport.call({ token: TOKEN, method: "getMe" });
    await tls.ready();
    tls.attempts[0]!.socket.emit("connect");
    tls.attempts[0]!.outgoing.emit("error", failure("CERT_HAS_EXPIRED"));
    await expect(tlsCall).resolves.toEqual({ ok: false, kind: "network_before_send", category: "tls" });
    expect(tls.factory).toHaveBeenCalledOnce();

    const sent = harness();
    const sentCall = sent.transport.call({ token: TOKEN, method: "sendMessage", params: { chat_id: 1, text: "x" } });
    await sent.ready();
    sent.connect(0);
    sent.attempts[0]!.outgoing.emit("error", failure("ECONNRESET"));
    const outcome = await sentCall;
    expect(outcome).toEqual({ ok: false, kind: "network_after_send", category: "reset" });
    expect(sent.factory).toHaveBeenCalledOnce();
    assertNoSecrets(outcome);
  });

  it("fires the 15 s JSON deadline: before sending it is retry-safe, after sending it is a timeout", async () => {
    vi.useFakeTimers();
    const stalled = harness();
    const stalledCall = stalled.transport.call({ token: TOKEN, method: "getMe" });
    await stalled.ready();
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(stalledCall).resolves.toEqual({ ok: false, kind: "network_before_send", category: "timeout" });

    const waiting = harness();
    const waitingCall = waiting.transport.call({ token: TOKEN, method: "sendMessage", params: { chat_id: 1, text: "x" } });
    await waiting.ready();
    waiting.connect(0);
    await vi.advanceTimersByTimeAsync(14_999);
    let settled = false;
    void waitingCall.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(waitingCall).resolves.toEqual({ ok: false, kind: "timeout" });
    expect(waiting.attempts[0]!.destroy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives a long poll its poll timeout plus 10 s", async () => {
    vi.useFakeTimers();
    const h = harness();
    const poll = h.transport.longPoll({ token: TOKEN, method: "getUpdates", params: { timeout: 25 }, pollTimeoutSeconds: 25 });
    await h.ready();
    h.connect(0);
    let settled = false;
    void poll.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(34_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(poll).resolves.toEqual({ ok: false, kind: "timeout" });
  });

  it("gives file transfers 60 s", async () => {
    vi.useFakeTimers();
    const h = harness();
    const download = h.transport.download({ token: TOKEN, filePath: "voice/file_1.oga" });
    await h.ready();
    h.connect(0);
    expect(h.attempts[0]!.options).toMatchObject({ method: "GET", path: `/file/bot${TOKEN}/voice/file_1.oga` });
    let settled = false;
    void download.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(download).resolves.toEqual({ ok: false, kind: "timeout" });
  });

  it("refuses responses over 1 MiB by declared length and while streaming", async () => {
    const declared = harness();
    const first = declared.transport.call({ token: TOKEN, method: "getMe" });
    await declared.ready();
    declared.connect(0);
    declared.attempts[0]!.respond(200, { "content-length": String(TELEGRAM_JSON_RESPONSE_MAX_BYTES + 1) });
    await expect(first).resolves.toEqual({ ok: false, kind: "too_large", status: 200 });
    expect(declared.attempts[0]!.destroy).toHaveBeenCalled();

    const streamed = harness();
    const second = streamed.transport.call({ token: TOKEN, method: "getMe" });
    await streamed.ready();
    streamed.connect(0);
    const incoming = streamed.attempts[0]!.respond(200);
    incoming.emit("data", Buffer.alloc(TELEGRAM_JSON_RESPONSE_MAX_BYTES));
    incoming.emit("data", Buffer.alloc(1));
    await expect(second).resolves.toEqual({ ok: false, kind: "too_large", status: 200 });
    expect(streamed.attempts[0]!.destroy).toHaveBeenCalled();
  });

  it("maps Telegram's refusal and keeps the token out of every outcome and error", async () => {
    const h = harness();
    const call = h.transport.call({ token: TOKEN, method: "getMe" });
    await h.ready();
    h.connect(0);
    h.reply(0, 401, { ok: false, error_code: 401, description: "Unauthorized" });
    const outcome = await call;
    expect(outcome).toMatchObject({ ok: false, kind: "telegram", status: 401, errorCode: 401 });
    assertNoSecrets(outcome);
    const invalid = await h.transport.call({ token: "123/../x", method: "getMe" }).catch((error: unknown) => error);
    expect(invalid).toMatchObject({ code: "telegram_request_invalid" });
    const badPath = await h.transport.download({ token: TOKEN, filePath: "../secret" }).catch((error: unknown) => error);
    expect(badPath).toMatchObject({ code: "telegram_request_invalid" });
    assertNoSecrets([invalid, badPath]);
  });

  it("refuses an upload over 50 MiB before connecting", async () => {
    const h = harness();
    const stream = Readable.from([Buffer.alloc(1)]);
    const outcome = await h.transport.upload({
      token: TOKEN, method: "sendDocument", fields: { chat_id: "1" },
      file: { field: "document", filename: "big.bin", contentType: "application/octet-stream", stream, size: 50 * 1024 * 1024 + 1 }
    });
    expect(outcome).toEqual({ ok: false, kind: "too_large" });
    expect(h.factory).not.toHaveBeenCalled();
    expect(stream.destroyed).toBe(true);
  });
});

describe("Telegram transport over a loopback server in test mode", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("refuses the loopback origin outside test mode", () => {
    expect(() => createTelegramTransport({ origin: "http://127.0.0.1:1", env: {} })).toThrow(TelegramTransportConfigError);
  });

  it("streams a multipart upload with its exact length and reads the reply", async () => {
    let received = { length: 0, type: "", body: "" };
    const origin = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks);
        received = { length: Number(request.headers["content-length"]), type: String(request.headers["content-type"]), body: body.toString("latin1") };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, result: { message_id: 9, chat: { id: 1, type: "private" }, date: 1 } }));
      });
    });
    const transport = createTelegramTransport({ origin, env: TEST_ENV });
    const payload = Buffer.from("document bytes");
    const outcome = await transport.upload({
      token: TOKEN, method: "sendDocument", fields: { chat_id: "1", caption: "Report" },
      file: { field: "document", filename: "re\"port\r\n.txt", contentType: "text/plain", stream: Readable.from([payload]), size: payload.length }
    });
    expect(outcome).toMatchObject({ ok: true, result: { message_id: 9 } });
    expect(received.type).toMatch(/^multipart\/form-data; boundary=/u);
    expect(received.body).toHaveLength(received.length);
    expect(received.body).toContain('name="caption"\r\n\r\nReport\r\n');
    expect(received.body).toContain('name="document"; filename="re_port__.txt"');
    expect(received.body).toContain("document bytes");
  });

  it("downloads within the cap and aborts a download that grows past it", async () => {
    let served = 0;
    const origin = await listen((request, response) => {
      if (request.url?.endsWith("small.oga")) { response.writeHead(200); response.end(Buffer.from("OggS")); return; }
      response.writeHead(200);
      const chunk = Buffer.alloc(1024 * 1024);
      const pump = () => {
        while (served <= TELEGRAM_DOWNLOAD_MAX_BYTES + chunk.length * 4) {
          served += chunk.length;
          if (!response.write(chunk)) { response.once("drain", pump); return; }
        }
        response.end();
      };
      response.on("error", () => undefined);
      pump();
    });
    const transport = createTelegramTransport({ origin, env: TEST_ENV });
    await expect(transport.download({ token: TOKEN, filePath: "voice/small.oga" })).resolves.toEqual({ ok: true, result: Buffer.from("OggS") });
    const big = await transport.download({ token: TOKEN, filePath: "documents/big.bin" });
    expect(big).toEqual({ ok: false, kind: "too_large", status: 200 });
    const capped = await transport.download({ token: TOKEN, filePath: "voice/small.oga", maxBytes: 2 });
    expect(capped).toEqual({ ok: false, kind: "too_large", status: 200 });
  });

  it("distinguishes a refused connection (before send) from a dropped one (after send)", async () => {
    const origin = await listen((request) => { request.socket.destroy(); });
    const transport = createTelegramTransport({ origin, env: TEST_ENV });
    await expect(transport.call({ token: TOKEN, method: "sendMessage", params: { chat_id: 1, text: "x" } }))
      .resolves.toMatchObject({ ok: false, kind: "network_after_send" });
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await expect(transport.call({ token: TOKEN, method: "getMe" }))
      .resolves.toEqual({ ok: false, kind: "network_before_send", category: "connect" });
  });
});
