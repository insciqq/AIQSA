import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateMemorySettings,
  refreshMemorySettings,
  updateMemoryGate,
  useMemorySettingsStore
} from "./memorySettingsStore";
import { memoryConsumerSettingsFixture } from "@/tests/support/memoryFixtures";
import { resetMemorySettingsStoreForTest } from "@/tests/support/appShellStores";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

describe("Memory settings store", () => {
  beforeEach(() => resetMemorySettingsStoreForTest());

  afterEach(() => {
    resetMemorySettingsStoreForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("round-trips all independent gate combinations without client CAS fields", async () => {
    let server = memoryConsumerSettingsFixture();
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const key = [
        "useMemoryFacts",
        "referenceChatHistory",
        "learnAutomatically",
        "synthesisEnabled",
        "decayEnabled"
      ].find(
        (candidate) => typeof body[candidate] === "boolean"
      ) as "decayEnabled" | "learnAutomatically" | "referenceChatHistory" | "synthesisEnabled" |
        "useMemoryFacts";
      server = memoryConsumerSettingsFixture({
        settings: { ...server.settings, [key]: body[key] as boolean },
        status: key === "useMemoryFacts" && body[key] === true ? "ON" : server.status
      });
      return json(server);
    }));
    useMemorySettingsStore.setState({ data: server, error: null, loadState: "ready" });

    await updateMemoryGate("useMemoryFacts", true);
    await updateMemoryGate("referenceChatHistory", true);
    await updateMemoryGate("learnAutomatically", true);
    await updateMemoryGate("synthesisEnabled", true);
    await updateMemoryGate("decayEnabled", true);

    expect(useMemorySettingsStore.getState().data?.settings).toEqual({
      decayEnabled: true,
      learnAutomatically: true,
      referenceChatHistory: true,
      synthesisEnabled: true,
      useMemoryFacts: true
    });
    expect(bodies).toEqual([
      { useMemoryFacts: true },
      { referenceChatHistory: true },
      { learnAutomatically: true },
      { synthesisEnabled: true },
      { decayEnabled: true }
    ]);
    expect(JSON.stringify(bodies)).not.toMatch(/revision|generation|fingerprint|deployment/iu);
  });

  it("reconciles the safe projection after a changed-state response", async () => {
    const initial = memoryConsumerSettingsFixture();
    const current = memoryConsumerSettingsFixture({
      settings: { useMemoryFacts: true },
      status: "ON"
    });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json({ error: "memory_changed" }, 409))
      .mockResolvedValueOnce(json(current)));
    useMemorySettingsStore.setState({ data: initial, error: null, loadState: "ready" });

    await expect(updateMemoryGate("useMemoryFacts", true)).rejects.toThrow("memory_changed");

    expect(useMemorySettingsStore.getState().data).toEqual(current);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent settings loads", async () => {
    const settings = memoryConsumerSettingsFixture();
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { resolve = done; })));

    const first = refreshMemorySettings();
    const second = refreshMemorySettings();
    resolve(json(settings));

    await expect(Promise.all([first, second])).resolves.toEqual([settings, settings]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("ignores a late settings response from the previous account", async () => {
    const oldSettings = memoryConsumerSettingsFixture({
      settings: { useMemoryFacts: false },
      status: "PAUSED"
    });
    const currentSettings = memoryConsumerSettingsFixture({
      settings: { useMemoryFacts: true },
      status: "ON"
    });
    const pending: Array<(response: Response) => void> = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      pending.push(resolve);
    })));

    activateMemorySettings("account-old");
    const oldLoad = refreshMemorySettings();
    activateMemorySettings("account-current");
    const currentLoad = refreshMemorySettings();

    pending[1]?.(json(currentSettings));
    await expect(currentLoad).resolves.toEqual(currentSettings);
    pending[0]?.(json(oldSettings));
    await expect(oldLoad).resolves.toEqual(oldSettings);

    expect(useMemorySettingsStore.getState()).toMatchObject({
      accountId: "account-current",
      data: currentSettings,
      loadState: "ready"
    });
  });
});
