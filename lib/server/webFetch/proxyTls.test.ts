// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as httpServer, request as httpRequest } from "node:http";
import { createServer as httpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureContext, TLSSocket, type ConnectionOptions } from "node:tls";
import type * as tls from "node:tls";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as address from "../proxies/address";
import { pageResponse, proxyConnection } from "./proxy.testFixtures";
import { fetchThroughProxy } from "./transport";

vi.mock("../proxies/address", async (original) => ({ ...await original<typeof address>(),
  checkProxyAddress: vi.fn(async (connection: { host: string; port: number }) => ({
    ...connection, ok: true, pinned: { address: "127.0.0.1", family: 4 }
  }))
}));
vi.mock("node:tls", async (original) => ({ ...await original<typeof tls>(), connect: vi.fn() }));
const actualTls = await vi.importActual<typeof tls>("node:tls");
const mockedTls = await import("node:tls");
const tlsConnect = mockedTls.connect as (options: ConnectionOptions) => TLSSocket;
let directory: string;
let key: Buffer;
let cert: Buffer;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "aiqsa-proxy-tls-"));
  // Ephemeral synthetic identity; no fixture private key is kept in Git, and no external service is used.
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=proxy.example.net",
    "-addext", "subjectAltName=DNS:proxy.example.net,DNS:example.com", "-keyout", join(directory, "key.pem"),
    "-out", join(directory, "cert.pem")], { stdio: "ignore" });
  key = readFileSync(join(directory, "key.pem"));
  cert = readFileSync(join(directory, "cert.pem"));
});
beforeEach(() => {
  // Trust only the test certificate while preserving the real TLS handshake and hostname verification.
  vi.mocked(tlsConnect).mockReset().mockImplementation((options: ConnectionOptions) => actualTls.connect({ ...options, ca: cert }));
});
afterEach(async () => { await Promise.all(cleanups.splice(0).map((close) => close())); });
afterAll(() => { if (directory) rmSync(directory, { force: true, recursive: true }); });

async function proxy(secureProxy: boolean, secureTarget: boolean) {
  const server = secureProxy ? httpsServer({ cert, key }) : httpServer();
  const sockets = new Set<import("node:stream").Duplex>();
  const connects: string[] = [];
  const pages: string[] = [];
  const proxyRequests: { url: string; authorization: string | undefined }[] = [];
  const origin = httpServer((request, response) => {
    pages.push(`${request.method} ${request.url} ${request.rawHeaders.join(" ")}`);
    response.writeHead(200, { "content-type": "text/plain" }).end("Synthetic page content");
  });
  origin.on("connection", (socket) => { sockets.add(socket); socket.on("error", () => undefined); });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originAddress = origin.address();
  if (!originAddress || typeof originAddress === "string") throw new Error("synthetic_proxy_address");
  server.on("request", (request, response) => {
    proxyRequests.push({ url: request.url ?? "", authorization: request.headers["proxy-authorization"] });
    const target = new URL(request.url!);
    const headers = { ...request.headers };
    delete headers["proxy-authorization"];
    // This local test proxy consumes its credentials and forwards only to its loopback origin.
    const outgoing = httpRequest({ host: "127.0.0.1", port: originAddress.port, path: target.pathname, headers }, (incoming) => {
      response.writeHead(incoming.statusCode!, incoming.headers);
      incoming.pipe(response);
    });
    outgoing.on("error", () => response.destroy());
    outgoing.end();
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("error", () => undefined); });
  server.on("tlsClientError", () => undefined);
  server.on("connect", (request, socket) => {
    connects.push(request.url ?? "");
    if (request.url?.endsWith(":80")) { socket.end("HTTP/1.1 403 CONNECT forbidden\r\n\r\n"); return; }
    socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
    const target = secureTarget ? new TLSSocket(socket, { isServer: true, secureContext: createSecureContext({ cert, key }) }) : socket;
    sockets.add(target);
    target.on("error", () => undefined);
    let content = "";
    target.on("data", (chunk: Buffer) => {
      content += chunk.toString();
      if (content.includes("\r\n\r\n")) { pages.push(content); target.end(pageResponse()); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const location = server.address();
  if (!location || typeof location === "string") throw new Error("synthetic_proxy_address");
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => origin.close(() => resolve()));
  });
  return { connects, proxyRequests, pages, port: location.port };
}

describe("proxy TLS", () => {
  it.each([[false, true], [true, false], [true, true]])("verifies TLS on proxy=%s and target=%s", async (secureProxy, secureTarget) => {
    const server = await proxy(secureProxy, secureTarget);
    const response = await fetchThroughProxy(`${secureTarget ? "https" : "http"}://example.com/page`,
      proxyConnection(server.port, secureProxy ? "https" : "http"), { acceptsContentType: () => true, limits: { deadlineMs: 1000 } });
    expect(Buffer.from(response.body).toString()).toBe("Synthetic page content");
    expect(server.connects).toEqual(secureTarget ? ["example.com:443"] : []);
    expect(server.pages).toHaveLength(1);
    expect(server.pages[0]).not.toMatch(/synthetic-password|authorization/iu);
    for (const [options] of vi.mocked(tlsConnect).mock.calls) expect(options).toMatchObject({ rejectUnauthorized: true });
  });

  it.each([false, true])("serves HTTP through a proxy refusing CONNECT to port 80 (TLS proxy=%s)", async (secureProxy) => {
    const server = await proxy(secureProxy, false);
    const connection = proxyConnection(server.port, secureProxy ? "https" : "http");
    const result = await fetchThroughProxy("http://example.com/page", connection, { acceptsContentType: () => true });
    expect(Buffer.from(result.body).toString()).toBe("Synthetic page content");
    expect(server.connects).toEqual([]);
    expect(server.proxyRequests).toEqual([{ url: "http://example.com/page",
      authorization: `Basic ${Buffer.from(`${connection.login}:${connection.password}`).toString("base64")}` }]);
    expect(server.pages).toHaveLength(1);
    expect(server.pages[0]).toContain("GET /page");
    expect(server.pages[0]).not.toMatch(/authorization|synthetic-user|synthetic-password/iu);
  });

  it("refuses a proxy certificate for the wrong name before sending credentials", async () => {
    const server = await proxy(true, false);
    await expect(fetchThroughProxy("http://example.com/", { ...proxyConnection(server.port, "https"), host: "wrong.example.net" },
      { acceptsContentType: () => true, limits: { deadlineMs: 1000 } })).rejects.toMatchObject({ code: "proxy_tls_failed" });
    expect(server.connects).toEqual([]);
  });

  it("verifies the target certificate inside a TLS proxy tunnel", async () => {
    const server = await proxy(true, true);
    await expect(fetchThroughProxy("https://wrong.example.com/", proxyConnection(server.port, "https"),
      { acceptsContentType: () => true, limits: { deadlineMs: 1000 } })).rejects.toMatchObject({ code: "fetch_network_error" });
    expect(server.pages).toEqual([]);
  });
});
