// @vitest-environment node
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const relay = fileURLToPath(new URL("./storage-relay.cjs", import.meta.url));
// Only the relay's own variables: no inherited application secrets.
function relayEnv(extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", PATH: process.env.PATH ?? "", ...extra };
}
const held: Server[] = [];
afterEach(async () => {
  await Promise.all(held.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function records(stdout: string): Record<string, unknown>[] {
  return stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function heldPort(): Promise<number> {
  const server = createServer();
  held.push(server);
  server.listen({ host: "0.0.0.0", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("port_unavailable");
  return address.port;
}

describe("storage relay logging", () => {
  it("writes its configuration refusal through the shared structured writer", () => {
    const result = spawnSync(process.execPath, [relay], { encoding: "utf8", env: relayEnv({ AIQSA_STORAGE_SOCKET: "relative.sock" }) });
    expect(result.status).toBe(64);
    expect(records(result.stdout)).toEqual([expect.objectContaining({
      event: "runtime_lifecycle", level: "error", role: "storage_relay", subsystem: "object_storage", stage: "startup",
      outcome: "failed", action: "stop", code: "storage_relay_configuration_invalid",
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), app_version: expect.any(String)
    })]);
    expect(result.stdout).not.toContain("relative.sock");
  });

  it("reports a listener failure by its system code without the socket path", async () => {
    const port = await heldPort();
    const result = spawnSync(process.execPath, [relay], { encoding: "utf8", timeout: 10_000,
      env: relayEnv({ AIQSA_STORAGE_SOCKET: "/run/private-socket/s3.sock", AIQSA_STORAGE_RELAY_PORT: String(port) }) });
    expect(result.status).toBe(1);
    expect(records(result.stdout)).toEqual([expect.objectContaining({
      event: "runtime_lifecycle", level: "error", role: "storage_relay", stage: "startup", outcome: "failed", code: "EADDRINUSE"
    })]);
    expect(result.stdout).not.toContain("private-socket");
  });

  it("announces a ready listener and stops on SIGTERM", async () => {
    const port = await heldPort();
    await new Promise<void>((resolve) => held.pop()!.close(() => resolve()));
    const child = spawn(process.execPath, [relay], { stdio: ["ignore", "pipe", "inherit"],
      env: relayEnv({ AIQSA_STORAGE_SOCKET: "/run/private-socket/s3.sock", AIQSA_STORAGE_RELAY_PORT: String(port) }) });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    const ready = new Promise<void>((resolve) => child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("\n")) resolve();
    }));
    const exited = once(child, "exit");
    await ready;
    child.kill("SIGTERM");
    const [code] = await exited;
    expect(code).toBe(0);
    expect(records(stdout)).toEqual([expect.objectContaining({
      event: "runtime_lifecycle", level: "info", role: "storage_relay", subsystem: "object_storage", stage: "startup", outcome: "completed"
    })]);
  });

  it("refuses an invalid idle timeout", () => {
    const result = spawnSync(process.execPath, [relay], { encoding: "utf8",
      env: relayEnv({ AIQSA_STORAGE_SOCKET: "/run/private-socket/s3.sock", AIQSA_STORAGE_RELAY_IDLE_TIMEOUT_MS: "0" }) });
    expect(result.status).toBe(64);
    expect(records(result.stdout)).toEqual([expect.objectContaining({ code: "storage_relay_configuration_invalid" })]);
  });
});

type RunningRelay = Readonly<{
  port: number;
  records(): Record<string, unknown>[];
  upstreams: Socket[];
  upstreamClosed: Promise<void>[];
  closedUpstreams(): number;
}>;

const children: ChildProcess[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function until(condition: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition_timed_out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function runningRelay(env: Readonly<Record<string, string>>, onUpstream: (socket: Socket) => void = () => {}): Promise<RunningRelay> {
  const directory = await mkdtemp(join(tmpdir(), "aiqsa-relay-"));
  directories.push(directory);
  const socketPath = join(directory, "s3.sock");
  const upstreams: Socket[] = [];
  const upstreamClosed: Promise<void>[] = [];
  let closedUpstreams = 0;
  const upstream = createServer((socket) => {
    upstreams.push(socket);
    upstreamClosed.push(new Promise((resolve) => socket.once("close", () => {
      closedUpstreams += 1;
      resolve();
    })));
    socket.on("error", () => {});
    onUpstream(socket);
  });
  held.push(upstream);
  upstream.listen(socketPath);
  await once(upstream, "listening");

  const port = await heldPort();
  await new Promise<void>((resolve) => held.pop()!.close(() => resolve()));
  const child = spawn(process.execPath, [relay], { stdio: ["ignore", "pipe", "inherit"],
    env: relayEnv({ AIQSA_STORAGE_SOCKET: socketPath, AIQSA_STORAGE_RELAY_PORT: String(port), ...env }) });
  children.push(child);
  let stdout = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => stdout += chunk);
  const parsed = () => records(stdout.slice(0, stdout.lastIndexOf("\n") + 1));
  await until(() => parsed().some((record) => record.stage === "startup"));
  return { port, records: parsed, upstreams, upstreamClosed, closedUpstreams: () => closedUpstreams };
}

async function connected(port: number): Promise<Socket> {
  const socket = connect({ host: "127.0.0.1", port });
  await once(socket, "connect");
  return socket;
}

describe("storage relay connections", () => {
  it("closes both sides of a connection idle past the timeout", async () => {
    const relayed = await runningRelay({ AIQSA_STORAGE_RELAY_IDLE_TIMEOUT_MS: "500" });
    const client = await connected(relayed.port);
    const clientClosed = once(client, "close");
    await until(() => relayed.upstreams.length === 1);
    const idleSince = Date.now();

    await clientClosed;
    await relayed.upstreamClosed[0];
    expect(Date.now() - idleSince).toBeGreaterThanOrEqual(400);
  });

  it("keeps a connection open while data moves in either direction", async () => {
    let received = 0;
    const relayed = await runningRelay({ AIQSA_STORAGE_RELAY_IDLE_TIMEOUT_MS: "500" }, (socket) => {
      socket.on("data", (chunk: Buffer) => received += chunk.byteLength);
    });
    const client = await connected(relayed.port);
    let delivered = 0;
    client.on("data", (chunk: Buffer) => delivered += chunk.byteLength);
    let closed = false;
    client.once("close", () => closed = true);
    await until(() => relayed.upstreams.length === 1);

    // Each phase lasts several timeouts, with gaps shorter than one.
    for (let index = 0; index < 10; index += 1) {
      relayed.upstreams[0]!.write("d");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (let index = 0; index < 10; index += 1) {
      client.write("u");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(closed).toBe(false);
    expect(delivered).toBe(10);
    expect(received).toBe(10);

    await relayed.upstreamClosed[0];
    await until(() => closed);
  });

  it("warns once as open connections approach the limit and again after they fall", async () => {
    // Warns at 4 of 5 and re-arms at 3.
    const relayed = await runningRelay({ AIQSA_STORAGE_RELAY_MAX_CONNECTIONS: "5" });
    const warnings = () => relayed.records().filter((record) => record.code === "storage_relay_connections_high");
    const clients = [];
    for (let index = 0; index < 5; index += 1) clients.push(await connected(relayed.port));
    await until(() => relayed.upstreams.length === 5);
    await until(() => warnings().length === 1);
    expect(warnings()).toEqual([expect.objectContaining({
      event: "runtime_lifecycle", level: "warn", role: "storage_relay", subsystem: "object_storage", stage: "health",
      outcome: "degraded", action: "none", count: 4
    })]);

    // Dropping to 4 does not re-arm; dropping to 3 does.
    clients.pop()!.destroy();
    await until(() => relayed.closedUpstreams() === 1);
    clients.push(await connected(relayed.port));
    await until(() => relayed.upstreams.length === 6);
    for (const client of clients.splice(3)) client.destroy();
    await until(() => relayed.closedUpstreams() === 3);
    clients.push(await connected(relayed.port));
    await until(() => relayed.upstreams.length === 7);
    await until(() => warnings().length === 2);
    expect(warnings().map((record) => record.count)).toEqual([4, 4]);
    for (const client of clients) client.destroy();
  });
});
