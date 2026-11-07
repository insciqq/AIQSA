import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONNECT_DEFAULT_HELLO_V2_LIMITS,
  CONNECT_MAX_WRITE_BYTES,
  connectServerCommandV2Schema,
  type ConnectOp,
  type ConnectOpArgs
} from "@/lib/contracts/connect";
import { createConnectComputerOps } from "./computerOps";
import type { ComputerOpCall } from "./computerPort";
import { createConnectRelay, type ConnectDeviceRecord } from "./relay";

const logs = vi.hoisted(() => ({ logConnect: vi.fn() }));
vi.mock("./observability", () => logs);

const RUN_ID = "1679091c-5a88-4faf-afb5-e6087eb1b2dc";
const readResult = { content: "hello\n", encoding: "utf-8", lineEnding: "lf", startLine: 1, totalLines: 1, truncated: false } as const;

function record(userId: string): ConnectDeviceRecord {
  return {
    arch: "amd64",
    clientVersion: "0.4.22",
    createdAt: new Date("2026-11-07T08:00:00.000Z"),
    hostname: "synthetic-host.local",
    id: randomUUID(),
    lastSeenAt: new Date("2026-11-07T09:00:00.000Z"),
    name: "Synthetic desktop",
    os: "windows",
    userId
  };
}

function setup() {
  const relay = createConnectRelay();
  const stored = new Map<string, ConnectDeviceRecord>();
  const policy = { enabled: vi.fn(async () => true) };
  const repository = {
    deviceExists: vi.fn(async (input: { id: string; userId: string }) => stored.get(input.id)?.userId === input.userId),
    findDevice: vi.fn(async (input: { id: string; userId: string }) => {
      const device = stored.get(input.id);
      return device && device.userId === input.userId ? device : null;
    })
  };
  const ops = createConnectComputerOps({ policy, relay, repository });
  const frames: Array<{ data: unknown; event: string }> = [];
  function online(device: ConnectDeviceRecord) {
    const tokenHash = randomUUID();
    relay.attachDevice({
      epoch: relay.epoch(),
      hello: { deviceId: device.id, limits: CONNECT_DEFAULT_HELLO_V2_LIMITS, minClientVersion: "0.3.20", protocol: 2, serverVersion: "0.4.22" },
      record: device,
      tokenHash,
      writer: { close() {}, send: (event, data) => (frames.push({ data, event }), true) }
    });
    return tokenHash;
  }
  function seed(userId: string) {
    const device = record(userId);
    stored.set(device.id, device);
    return device;
  }
  return { frames, online, ops, policy, relay, repository, seed };
}

function readCall(device: Readonly<{ id: string }>, userId: string, overrides: Partial<ComputerOpCall> = {}): ComputerOpCall {
  return {
    args: { cwd: "~", limit: 2000, offset: 1, path: "notes.txt" },
    deviceId: device.id,
    op: "read",
    runId: RUN_ID,
    signal: new AbortController().signal,
    timeoutMs: 30_000,
    userId,
    ...overrides
  } as ComputerOpCall;
}

function lastOpRequestId(frames: ReadonlyArray<{ data: unknown; event: string }>): string {
  const command = connectServerCommandV2Schema.parse(frames.filter((frame) => frame.event === "command").at(-1)!.data);
  if (command.type !== "op") throw new Error("not an op");
  return command.requestId;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Connect computer ops", () => {
  it("runs an op on the owner's online device and returns its checked result", async () => {
    const context = setup();
    const device = context.seed("alice");
    const tokenHash = context.online(device);

    const pending = context.ops.call(readCall(device, "alice"));
    await vi.waitFor(() => expect(context.frames.some((frame) => frame.event === "command")).toBe(true));
    context.relay.acceptEvents(tokenHash, [{ ok: true, requestId: lastOpRequestId(context.frames), result: readResult, type: "reply" }]);
    await expect(pending).resolves.toEqual({ ok: true, result: readResult });
  });

  it("answers another account's device exactly like a missing one, online or not, and sends it nothing", async () => {
    const context = setup();
    const own = context.seed("alice");
    const foreignOnline = context.seed("bob");
    const foreignOffline = context.seed("bob");
    context.online(foreignOnline);
    const sent = context.frames.length;

    const unavailable = { code: "connect_device_unavailable", ok: false, sent: false };
    for (const deviceId of [foreignOnline.id, foreignOffline.id, randomUUID(), "not-a-device"]) {
      await expect(context.ops.call(readCall({ id: deviceId }, "alice"))).resolves.toEqual(unavailable);
      await expect(context.ops.describe("alice", deviceId)).resolves.toBeNull();
    }
    expect(context.frames).toHaveLength(sent);
    // The owner's own offline device is offline, not unavailable.
    await expect(context.ops.call(readCall(own, "alice"))).resolves.toEqual({ code: "connect_device_offline", ok: false, sent: false });
    context.ops.runEnded({ deviceId: foreignOnline.id, runId: RUN_ID, userId: "alice" });
    expect(context.frames).toHaveLength(sent);
  });

  it("describes the owner's device with what it reported while online", async () => {
    const context = setup();
    const device = context.seed("alice");
    await expect(context.ops.describe("alice", device.id)).resolves.toEqual({ arch: "amd64", name: "Synthetic desktop", online: false, os: "windows" });

    const tokenHash = context.online(device);
    context.relay.acceptEvents(tokenHash, [{
      arch: "amd64",
      home: "C:\\Users\\synthetic",
      hostname: "DESKTOP-SYNTH",
      os: "windows",
      osVersion: "Windows 11 Pro 23H2",
      shell: { kind: "pwsh", name: "PowerShell", version: "7.4.6" },
      type: "device_info"
    }]);
    await expect(context.ops.describe("alice", device.id)).resolves.toEqual({
      arch: "amd64",
      info: { home: "C:\\Users\\synthetic", osVersion: "Windows 11 Pro 23H2", shell: { kind: "pwsh", name: "PowerShell", version: "7.4.6" } },
      name: "Synthetic desktop",
      online: true,
      os: "windows"
    });
  });

  it("refuses while AIQSA Connect is off and treats an unreadable switch as offline, sending nothing", async () => {
    const context = setup();
    const device = context.seed("alice");
    context.online(device);
    const sent = context.frames.length;
    context.policy.enabled.mockResolvedValueOnce(false);
    await expect(context.ops.call(readCall(device, "alice"))).resolves.toEqual({ code: "connect_disabled", ok: false, sent: false });
    context.policy.enabled.mockRejectedValueOnce(new Error("database at 10.0.0.5 unreachable"));
    await expect(context.ops.call(readCall(device, "alice"))).resolves.toEqual({ code: "connect_device_offline", ok: false, sent: false });
    expect(context.frames).toHaveLength(sent);
    expect(JSON.stringify(logs.logConnect.mock.calls)).not.toContain(device.id);
  });

  it.each<[string, Partial<ComputerOpCall>, string]>([
    ["arguments outside the contract", { args: { cwd: "~", limit: 5_000, offset: 1, path: "x" } as ConnectOpArgs }, "connect_device_error"],
    ["an unknown key", { args: { cwd: "~", limit: 10, offset: 1, path: "x", extra: true } as unknown as ConnectOpArgs }, "connect_device_error"],
    ["a path with a control character", { args: { cwd: "~", limit: 10, offset: 1, path: "a\u0007b" } }, "connect_device_error"],
    ["an unknown op", { op: "format_disk" as ConnectOp }, "connect_device_error"],
    ["a run id that is no id", { runId: "run-1" }, "connect_device_error"],
    ["no time to run", { timeoutMs: 0 }, "connect_device_error"],
    ["write content over the bound", {
      args: { content: "x".repeat(CONNECT_MAX_WRITE_BYTES + 1), cwd: "~", path: "big.txt" },
      op: "write"
    }, "computer_file_too_large"]
  ])("bounds the call before anything is sent: %s", async (_case, overrides, code) => {
    const context = setup();
    const device = context.seed("alice");
    context.online(device);
    const sent = context.frames.length;
    await expect(context.ops.call(readCall(device, "alice", overrides))).resolves.toEqual({ code, ok: false, sent: false });
    expect(context.frames).toHaveLength(sent);
  });

  it("forwards cancellation and run ends to the owner's device", async () => {
    const context = setup();
    const device = context.seed("alice");
    context.online(device);
    const controller = new AbortController();
    const pending = context.ops.call(readCall(device, "alice", { signal: controller.signal }));
    await vi.waitFor(() => expect(context.frames.some((frame) => frame.event === "command")).toBe(true));
    const requestId = lastOpRequestId(context.frames);
    controller.abort();
    await expect(pending).resolves.toEqual({ code: "computer_cancelled", ok: false, sent: true });
    expect(context.frames.at(-1)).toEqual({ data: { requestId, type: "cancel" }, event: "command" });

    context.ops.runEnded({ deviceId: device.id, runId: RUN_ID, userId: "alice" });
    expect(context.frames.at(-1)).toEqual({ data: { runId: RUN_ID, type: "run_ended" }, event: "command" });
    expect(() => context.ops.runEnded({ deviceId: "x", runId: "y", userId: "alice" })).not.toThrow();
  });
});
