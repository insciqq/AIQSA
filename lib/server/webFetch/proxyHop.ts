import { Agent, request } from "node:http";
import { connect, isIP, type Socket } from "node:net";
import { Readable } from "node:stream";
import { connect as connectTls } from "node:tls";
import { parseIpv4, parseIpv6 } from "../mcp/safeFetch";
import { checkProxyAddress, isRefusedProxyTarget } from "../proxies/address";
import type { RunProxyConnection } from "../proxies/runProxies";
import { WebFetchError, type WebFetchFailureCode } from "./errors";

/** What a request through a proxy needs of it. */
export type ProxyHopConnection = Pick<RunProxyConnection, "host" | "login" | "password" | "port" | "protocol">;

const fail = (code: WebFetchFailureCode, dispatched = true) => new WebFetchError(code, { dispatched });

/** Covers installation-environment discovery as well as the check's own DNS deadline. */
async function checkedAddress(connection: ProxyHopConnection, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<Awaited<ReturnType<typeof checkProxyAddress>>>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    checkProxyAddress(connection, { signal }).then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted));
  });
}

/** One bounded handshake read. No peer bytes ever become an error message. */
async function waitFor(socket: Socket, event: "readable" | "connect" | "secureConnect", signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (socket.destroyed || socket.readableEnded) throw fail("proxy_connect_failed");
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.off(event, ready).off("error", broken).off("close", broken).off("end", broken);
      signal.removeEventListener("abort", aborted);
    };
    const ready = () => { cleanup(); resolve(); };
    const broken = () => { cleanup(); reject(fail("proxy_connect_failed")); };
    const aborted = () => { cleanup(); reject(signal.reason); };
    socket.once(event, ready).once("error", broken).once("close", broken).once("end", broken);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

async function bytes(socket: Socket, size: number, signal: AbortSignal): Promise<Buffer> {
  while (true) {
    signal.throwIfAborted();
    const chunk = socket.read(size) as Buffer | null;
    if (chunk !== null) {
      if (chunk.length !== size) throw fail("proxy_protocol_error");
      return chunk;
    }
    await waitFor(socket, "readable", signal);
  }
}

async function httpTunnel(socket: Socket, url: URL, connection: ProxyHopConnection, signal: AbortSignal) {
  const authority = `${url.hostname}:${url.port || (url.protocol === "https:" ? 443 : 80)}`;
  const auth = connection.login !== null || connection.password !== null
    ? `Proxy-Authorization: Basic ${Buffer.from(`${connection.login ?? ""}:${connection.password ?? ""}`).toString("base64")}\r\n` : "";
  // HTTPS targets use CONNECT; these credentials never enter the tunnel.
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`);
  let head = Buffer.alloc(0);
  while (true) {
    const chunk = socket.read() as Buffer | null;
    if (chunk === null) { await waitFor(socket, "readable", signal); continue; }
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end > 16_384 || (end < 0 && head.length > 16_384)) throw fail("proxy_protocol_error");
    if (end < 0) continue;
    const status = /^HTTP\/1\.[01] ([0-9]{3})(?: [^\r\n]*)?\r\n/u.exec(head.subarray(0, end + 2).toString("latin1"));
    if (!status) throw fail("proxy_protocol_error");
    if (status[1] === "407") throw fail("proxy_auth_failed");
    if (Number(status[1]) < 200 || Number(status[1]) > 299) throw fail("proxy_connect_failed");
    if (head.length > end + 4) socket.unshift(head.subarray(end + 4));
    return;
  }
}

async function socksTunnel(socket: Socket, url: URL, connection: ProxyHopConnection, signal: AbortSignal) {
  const auth = connection.login !== null || connection.password !== null;
  socket.write(Buffer.from([5, 1, auth ? 2 : 0]));
  const hello = await bytes(socket, 2, signal);
  if (hello[0] !== 5) throw fail("proxy_protocol_error");
  if (hello[1] === 255 || (auth && hello[1] === 0)) throw fail("proxy_auth_failed");
  if (hello[1] !== (auth ? 2 : 0)) throw fail("proxy_protocol_error");
  if (auth) {
    const login = Buffer.from(connection.login ?? "");
    const password = Buffer.from(connection.password ?? "");
    if (!login.length || login.length > 255 || !password.length || password.length > 255) throw fail("proxy_auth_failed");
    socket.write(Buffer.concat([Buffer.from([1, login.length]), login, Buffer.from([password.length]), password]));
    const answer = await bytes(socket, 2, signal);
    if (answer[0] !== 1) throw fail("proxy_protocol_error");
    if (answer[1] !== 0) throw fail("proxy_auth_failed");
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const host = Buffer.from(hostname);
  if (host.length > 255) throw fail("proxy_protocol_error");
  // Only domain names need proxy DNS. Literal addresses use SOCKS's native wire forms.
  let destination = Buffer.concat([Buffer.from([3, host.length]), host]);
  if (isIP(hostname) === 4) {
    destination = Buffer.alloc(5);
    destination[0] = 1;
    destination.writeUInt32BE(parseIpv4(hostname)!, 1);
  } else if (isIP(hostname) === 6) {
    const value = parseIpv6(hostname)!;
    destination = Buffer.alloc(17);
    destination[0] = 4;
    destination.writeBigUInt64BE(value >> 64n, 1);
    destination.writeBigUInt64BE(value & ((1n << 64n) - 1n), 9);
  }
  const port = Buffer.alloc(2);
  port.writeUInt16BE(Number(url.port || (url.protocol === "https:" ? 443 : 80)));
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), destination, port]));
  const reply = await bytes(socket, 4, signal);
  if (reply[0] !== 5 || reply[2] !== 0 || ![1, 3, 4].includes(reply[3]!)) throw fail("proxy_protocol_error");
  if (reply[1] !== 0) throw fail("proxy_connect_failed");
  const length = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : (await bytes(socket, 1, signal))[0]!;
  if (!length) throw fail("proxy_protocol_error");
  await bytes(socket, length + 2, signal);
}

/** GET through a fresh proxy connection. Every hop checks DNS again; there is no shared pool. */
export async function fetchProxyHop(url: URL, connection: ProxyHopConnection, headers: Record<string, string>,
  signal: AbortSignal): Promise<Response> {
  const targetHost = url.hostname.replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  if (isRefusedProxyTarget(url) || (!isIP(targetHost) && (!targetHost.includes(".") || targetHost.endsWith(".local")))) {
    throw fail("fetch_blocked_address", false);
  }
  signal.throwIfAborted();
  const checked = await checkedAddress(connection, signal);
  if (!checked.ok) throw fail(checked.code, false);
  signal.throwIfAborted();
  let socket: Socket | undefined;
  let agent: Agent | undefined;
  let phase: WebFetchFailureCode = "proxy_connect_failed";
  const destroy = () => { socket?.destroy(); agent?.destroy(); };
  const cleanup = () => { signal.removeEventListener("abort", destroy); destroy(); };
  signal.addEventListener("abort", destroy, { once: true });
  try {
    socket = connect({ host: checked.pinned.address, family: checked.pinned.family, port: checked.port });
    socket.on("error", () => undefined);
    await waitFor(socket, "connect", signal);
    if (connection.protocol === "https") {
      phase = "proxy_tls_failed";
      socket = connectTls({ socket, host: checked.host, servername: isIP(checked.host) ? undefined : checked.host,
        rejectUnauthorized: true, ALPNProtocols: ["http/1.1"] });
      socket.on("error", () => undefined);
      await waitFor(socket, "secureConnect", signal);
    }
    phase = "proxy_connect_failed";
    const forward = connection.protocol !== "socks5" && url.protocol === "http:";
    if (connection.protocol === "socks5") await socksTunnel(socket, url, connection, signal);
    else if (!forward) await httpTunnel(socket, url, connection, signal);
    if (url.protocol === "https:") {
      phase = "fetch_network_error";
      const host = url.hostname.replace(/^\[|\]$/gu, "");
      socket = connectTls({ socket, host, servername: isIP(host) ? undefined : host,
        rejectUnauthorized: true, ALPNProtocols: ["http/1.1"] });
      socket.on("error", () => undefined);
      await waitFor(socket, "secureConnect", signal);
    }
    phase = "proxy_connect_failed";
    const tunnel = socket;
    agent = new Agent({ keepAlive: false });
    // The request uses the proxy connection or tunnel already open: its agent never dials.
    (agent as Agent & { createConnection(): Socket }).createConnection = () => tunnel;
    return await new Promise<Response>((resolve, reject) => {
      const auth = forward && (connection.login !== null || connection.password !== null)
        ? { "proxy-authorization": `Basic ${Buffer.from(`${connection.login ?? ""}:${connection.password ?? ""}`).toString("base64")}` } : {};
      // Absolute form addresses the proxy itself. It consumes Proxy-Authorization before forwarding to the target.
      const outgoing = request({ agent, headers: { ...headers, ...auth, connection: "close", host: url.host },
        hostname: forward ? checked.host : url.hostname, port: forward ? checked.port : undefined,
        method: "GET", path: forward ? url.href : `${url.pathname}${url.search}`, signal,
        maxHeaderSize: 16_384 }, (incoming) => {
        const status = incoming.statusCode ?? 0;
        if (status < 200 || status > 599) { cleanup(); reject(fail("proxy_protocol_error")); return; }
        if (forward && status === 407) { incoming.destroy(); cleanup(); reject(fail("proxy_auth_failed")); return; }
        try {
          const responseHeaders = new Headers();
          for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
            responseHeaders.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
          }
          incoming.once("close", cleanup);
          const bodyAllowed = ![204, 205, 304].includes(status);
          const body = bodyAllowed ? Readable.toWeb(incoming) as ReadableStream<Uint8Array> : null;
          if (!bodyAllowed) incoming.resume();
          resolve(new Response(body, { headers: responseHeaders, status }));
        } catch {
          incoming.destroy();
          cleanup();
          reject(fail("proxy_protocol_error"));
        }
      });
      outgoing.once("upgrade", (_incoming, upgraded) => {
        upgraded.destroy();
        cleanup();
        reject(fail("proxy_protocol_error"));
      });
      outgoing.once("error", (error: NodeJS.ErrnoException) => {
        cleanup();
        reject(signal.aborted ? signal.reason : fail(error.code?.startsWith("HPE_") ? "proxy_protocol_error" : phase));
      });
      outgoing.end();
    });
  } catch (error) {
    cleanup();
    if (signal.aborted) throw signal.reason;
    // waitFor deliberately hides socket details, while the phase still distinguishes TLS failures.
    if (error instanceof WebFetchError && error.code !== "proxy_connect_failed") throw error;
    throw fail(phase);
  }
}
