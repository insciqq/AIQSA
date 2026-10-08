import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPinnedPushPost, PushTransportError } from "./pushTransport";

const request = (endpoint = "https://push.example/device") => ({ body: Buffer.from("x"), endpoint: new URL(endpoint), headers: {} });
const addresses = [{ address: "2001:4860:4860::8888", family: 6 as const }, { address: "8.8.8.8", family: 4 as const }];
const failure = (code: string) => Object.assign(new Error("PRIVATE_ENDPOINT_AND_KEYS"), { code });

function harness() {
  const attempts: Array<{
    options: RequestOptions; outgoing: EventEmitter; socket: EventEmitter;
    end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>;
    respond: (status: number) => EventEmitter;
  }> = [];
  const factory = vi.fn((options: RequestOptions, callback: (incoming: IncomingMessage) => void) => {
    const outgoing = new EventEmitter();
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const end = vi.fn();
    const destroy = vi.fn();
    attempts.push({
      destroy, end, options, outgoing, socket,
      respond: (status) => {
        const incoming = Object.assign(new EventEmitter(), { destroy: vi.fn(), resume: vi.fn(), statusCode: status });
        callback(incoming as unknown as IncomingMessage);
        return incoming;
      }
    });
    queueMicrotask(() => outgoing.emit("socket", socket));
    return Object.assign(outgoing, { destroy, end }) as unknown as ClientRequest;
  });
  const resolve = vi.fn(async () => addresses);
  const post = createPinnedPushPost({ request: factory, resolve, timeoutMs: 100 });
  const ready = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  const connect = (index: number) => {
    attempts[index]!.socket.emit("connect");
    attempts[index]!.socket.emit("secureConnect");
  };
  return { attempts, connect, factory, post, ready, resolve };
}

afterEach(() => vi.useRealTimers());

describe("pinned push transport", () => {
  it.each([
    [[{ address: "10.0.0.8", family: 4 as const }]],
    [[{ address: "127.0.0.1", family: 4 as const }]],
    [[{ address: "169.254.169.254", family: 4 as const }]],
    [[{ address: "fd00::1", family: 6 as const }]],
    [[{ address: "8.8.8.8", family: 4 as const }, { address: "192.168.0.2", family: 4 as const }]],
    [[{ address: "8.8.8.8", family: 6 as const }]],
    [[]]
  ])("refuses a name that resolves to %j before connecting", async (records) => {
    const resolve = vi.fn(async () => records);
    const factory = vi.fn();
    await expect(createPinnedPushPost({ request: factory, resolve })(request()))
      .rejects.toMatchObject({ code: "push_endpoint_forbidden", category: undefined });
    expect(resolve).toHaveBeenCalledWith("push.example");
    expect(factory).not.toHaveBeenCalled();
  });

  it("refuses plain HTTP before DNS and reports a failed lookup as dns without raw error content", async () => {
    const h = harness();
    await expect(h.post(request("http://push.example/d"))).rejects.toBeInstanceOf(PushTransportError);
    expect(h.resolve).not.toHaveBeenCalled();
    h.resolve.mockRejectedValue(failure("ENOTFOUND"));
    const error = await h.post(request()).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "push_transport_failed", category: "dns", message: "push_transport_failed" });
    expect(JSON.stringify(error)).not.toContain("PRIVATE_");
    expect(h.factory).not.toHaveBeenCalled();
  });

  it.each(["ENETUNREACH", "EHOSTUNREACH", "ECONNREFUSED", "ETIMEDOUT"])("falls back after %s before writing, with DNS pinning and one POST", async (code) => {
    const h = harness();
    const delivery = h.post(request());
    await h.ready();
    h.attempts[0]!.outgoing.emit("error", failure(code));
    await h.ready();
    expect(h.attempts[0]!.destroy).toHaveBeenCalledOnce();
    expect(h.attempts[0]!.end).not.toHaveBeenCalled();
    h.connect(1);
    h.attempts[1]!.respond(201).emit("end");
    await expect(delivery).resolves.toEqual({ status: 201 });
    expect(h.resolve).toHaveBeenCalledOnce();
    expect(h.factory).toHaveBeenCalledTimes(2);
    for (const [index, attempt] of h.attempts.entries()) {
      const callback = vi.fn();
      attempt.options.lookup!("push.example", { all: true }, callback);
      expect(callback).toHaveBeenCalledWith(null, [addresses[index]]);
      expect(attempt.options).toMatchObject({ agent: false, host: "push.example", method: "POST", path: "/device", servername: "push.example" });
      expect(attempt.end).toHaveBeenCalledTimes(index);
    }
    expect(h.attempts[1]!.end).toHaveBeenCalledWith(Buffer.from("x"));
  });

  it("gives a stalled TCP connection only part of the deadline and ignores its late connection", async () => {
    vi.useFakeTimers();
    const h = harness();
    const delivery = h.post(request());
    await h.ready();
    await vi.advanceTimersByTimeAsync(50);
    expect(h.attempts).toHaveLength(2);
    h.connect(0);
    expect(h.attempts[0]!.end).not.toHaveBeenCalled();
    h.connect(1);
    h.attempts[1]!.respond(201).emit("end");
    await expect(delivery).resolves.toEqual({ status: 201 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["ENETUNREACH", "network_unreachable"], ["ECONNREFUSED", "connect"], ["ETIMEDOUT", "timeout"],
    ["ECONNRESET", "reset"], ["PRIVATE_UNKNOWN_CODE", "unknown"]
  ])("classifies exhausted connection failure %s as %s", async (code, category) => {
    const h = harness();
    const delivery = expect(h.post(request())).rejects.toMatchObject({ code: "push_transport_failed", category });
    await h.ready();
    h.attempts[0]!.outgoing.emit("error", failure(code));
    if (h.attempts.length > 1) h.attempts[1]!.outgoing.emit("error", failure(code));
    await delivery;
    expect(h.attempts.every((attempt) => attempt.end.mock.calls.length === 0)).toBe(true);
  });

  it.each([
    ["CERT_HAS_EXPIRED", "tls"], ["ERR_TLS_CERT_ALTNAME_INVALID", "tls"], ["ERR_SSL_WRONG_VERSION_NUMBER", "tls"],
    ["ECONNRESET", "reset"], ["ETIMEDOUT", "timeout"]
  ])("ends a TLS-phase %s failure as %s without trying another address", async (code, category) => {
    const h = harness();
    const delivery = expect(h.post(request())).rejects.toMatchObject({ category });
    await h.ready();
    h.attempts[0]!.socket.emit("connect");
    h.attempts[0]!.outgoing.emit("error", failure(code));
    await delivery;
    expect(h.factory).toHaveBeenCalledOnce();
    expect(h.attempts[0]!.end).not.toHaveBeenCalled();
  });

  it.each([
    ["ECONNRESET", "reset"], ["ETIMEDOUT", "timeout"], ["ECONNREFUSED", "connect"], ["ENETUNREACH", "network_unreachable"]
  ])("never resends after writing starts even for %s", async (code, category) => {
    const h = harness();
    const delivery = expect(h.post(request())).rejects.toMatchObject({ code: "push_transport_failed", category });
    await h.ready();
    h.connect(0);
    h.attempts[0]!.outgoing.emit("error", failure(code));
    await delivery;
    expect(h.factory).toHaveBeenCalledOnce();
    expect(h.attempts[0]!.end).toHaveBeenCalledOnce();
  });

  it("never resends when end throws synchronously or a response resets", async () => {
    for (const duringWrite of [true, false]) {
      const h = harness();
      const delivery = expect(h.post(request())).rejects.toMatchObject({ category: "reset" });
      await h.ready();
      if (duringWrite) h.attempts[0]!.end.mockImplementation(() => { throw failure("EPIPE"); });
      h.connect(0);
      if (!duringWrite) h.attempts[0]!.respond(201).emit("aborted");
      await delivery;
      expect(h.factory).toHaveBeenCalledOnce();
      expect(h.attempts[0]!.end).toHaveBeenCalledOnce();
    }
  });

  it.each(["dns", "tls", "response"])("bounds a stalled %s phase by the overall deadline", async (phase) => {
    vi.useFakeTimers();
    const h = harness();
    let resolveDns: (records: typeof addresses) => void = () => {};
    h.resolve.mockImplementation(() => new Promise((resolve) => { resolveDns = resolve; }));
    const delivery = expect(h.post(request())).rejects.toMatchObject({ category: "timeout" });
    await h.ready();
    await vi.advanceTimersByTimeAsync(25);
    if (phase !== "dns") {
      resolveDns(addresses);
      await h.ready();
      h.attempts[0]!.socket.emit("connect");
      if (phase === "response") {
        h.attempts[0]!.socket.emit("secureConnect");
        h.attempts[0]!.respond(201);
      }
    }
    await vi.advanceTimersByTimeAsync(75);
    await delivery;
    resolveDns(addresses);
    await h.ready();
    expect(h.factory).toHaveBeenCalledTimes(phase === "dns" ? 0 : 1);
    if (phase !== "dns") expect(h.attempts[0]!.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares the total deadline across fallback and a response that keeps making progress", async () => {
    vi.useFakeTimers();
    const h = harness();
    const delivery = expect(h.post(request())).rejects.toMatchObject({ category: "timeout" });
    await h.ready();
    await vi.advanceTimersByTimeAsync(50);
    h.connect(1);
    const response = h.attempts[1]!.respond(201);
    for (let tick = 0; tick < 5; tick += 1) {
      response.emit("data", Buffer.from("x"));
      await vi.advanceTimersByTimeAsync(10);
    }
    await delivery;
    expect(h.factory).toHaveBeenCalledTimes(2);
    expect(h.attempts[0]!.end).not.toHaveBeenCalled();
    expect(h.attempts[1]!.end).toHaveBeenCalledOnce();
    expect(h.attempts[1]!.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([201, 404, 410, 302])("returns HTTP %s without another POST or following redirects", async (status) => {
    const h = harness();
    const delivery = h.post(request());
    await h.ready();
    h.connect(0);
    h.attempts[0]!.respond(status).emit("end");
    await expect(delivery).resolves.toEqual({ status });
    expect(h.factory).toHaveBeenCalledOnce();
    expect(h.attempts[0]!.end).toHaveBeenCalledOnce();
  });
});
