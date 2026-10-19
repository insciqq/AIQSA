import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectPolicyGate } from "./policy";

const prismaMock = vi.hoisted(() => ({ prisma: { connectPolicy: { findUnique: vi.fn() } } }));
vi.mock("../prisma", () => prismaMock);

afterEach(() => {
  vi.clearAllMocks();
  delete (globalThis as { __aiqsaConnectPolicy?: unknown }).__aiqsaConnectPolicy;
});

describe("AIQSA Connect installation switch", () => {
  it("reuses a read briefly and replaces it at once with a committed change", async () => {
    let at = 1_000;
    const load = vi.fn().mockResolvedValue({ enabled: false, version: 1 });
    const gate = createConnectPolicyGate({ load, now: () => at, ttlMs: 5_000 });

    expect(await gate.enabled()).toBe(false);
    expect(await gate.enabled()).toBe(false);
    expect(load).toHaveBeenCalledOnce();

    gate.remember({ enabled: true, version: 2 });
    expect(await gate.enabled()).toBe(true);
    expect(load).toHaveBeenCalledOnce();

    at += 5_001;
    load.mockResolvedValue({ enabled: true, version: 2 });
    expect(await gate.read()).toEqual({ enabled: true, version: 2 });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("never lets a read that started before a change overwrite it", async () => {
    let finish: (policy: { enabled: boolean; version: number }) => void = () => undefined;
    const load = vi.fn(() => new Promise<{ enabled: boolean; version: number }>((resolve) => {
      finish = resolve;
    }));
    const gate = createConnectPolicyGate({ load });

    const stale = gate.enabled();
    gate.remember({ enabled: false, version: 3 });
    finish({ enabled: true, version: 2 });

    expect(await stale).toBe(true);
    expect(await gate.enabled()).toBe(false);
    expect(load).toHaveBeenCalledOnce();
  });

  it("shares concurrent reads and does not cache a failure", async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValue({ enabled: true, version: 4 });
    const gate = createConnectPolicyGate({ load });

    await expect(Promise.all([gate.enabled(), gate.enabled()])).rejects.toThrow("database unavailable");
    expect(load).toHaveBeenCalledOnce();
    expect(await gate.enabled()).toBe(true);
    gate.invalidate();
    expect(await gate.enabled()).toBe(true);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("reports the feature off while the installation policy cannot be read", async () => {
    const { isConnectEnabled } = await import("./policy");
    prismaMock.prisma.connectPolicy.findUnique.mockRejectedValueOnce(new Error("database unavailable"));
    expect(await isConnectEnabled()).toBe(false);

    prismaMock.prisma.connectPolicy.findUnique.mockResolvedValueOnce({ enabled: true, version: 2 });
    expect(await isConnectEnabled()).toBe(true);
    expect(prismaMock.prisma.connectPolicy.findUnique).toHaveBeenCalledWith({
      select: { enabled: true, version: true },
      where: { id: "installation" }
    });
  });
});
