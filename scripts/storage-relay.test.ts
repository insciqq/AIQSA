// @vitest-environment node
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:net";
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
});
