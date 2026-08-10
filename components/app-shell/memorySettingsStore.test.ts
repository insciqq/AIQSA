import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptCurrentMemoryDestinations,
  refreshMemorySettings,
  resetMemorySettingsStoreForTest,
  updateMemoryGate,
  updateMemoryLocale,
  useMemorySettingsStore
} from "./memorySettingsStore";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "@/lib/contracts/memory";
import { memorySettingsFixture } from "./memoryTestFixtures";

describe("Memory settings store", () => {
  beforeEach(() => resetMemorySettingsStoreForTest());
  afterEach(() => {
    resetMemorySettingsStoreForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("round-trips all eight independent gate combinations with exact CAS bodies", async () => {
    let server = memorySettingsFixture();
    const patchBodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      patchBodies.push(body);
      expect(body.expectedSettingsRevision).toBe(server.settings.settingsRevision);
      expect(body.expectedMemoryRevision).toBe(server.settings.memoryRevision);
      const key = ["useMemoryFacts", "referenceChatHistory", "learnAutomatically"].find(
        (candidate) => typeof body[candidate] === "boolean"
      ) as "learnAutomatically" | "referenceChatHistory" | "useMemoryFacts";
      server = memorySettingsFixture({
        settings: {
          ...server.settings,
          [key]: body[key] as boolean,
          memoryRevision: server.settings.memoryRevision + 1,
          settingsRevision: server.settings.settingsRevision + 1
        }
      });
      return new Response(JSON.stringify(server), {
        headers: { "content-type": "application/json" },
        status: 200
      });
    }));
    useMemorySettingsStore.setState({ data: server, error: null, loadState: "ready" });

    const states = [
      [false, false, false],
      [true, false, false],
      [true, true, false],
      [false, true, false],
      [false, true, true],
      [true, true, true],
      [true, false, true],
      [false, false, true]
    ] as const;
    const observed: Array<readonly [boolean, boolean, boolean]> = [states[0]];
    for (const next of states.slice(1)) {
      const current = useMemorySettingsStore.getState().data!.settings;
      const values = [current.useMemoryFacts, current.referenceChatHistory, current.learnAutomatically];
      const index = next.findIndex((value, candidate) => value !== values[candidate]);
      const key = ["useMemoryFacts", "referenceChatHistory", "learnAutomatically"] as const;
      await updateMemoryGate(key[index]!, next[index]!);
      const saved = useMemorySettingsStore.getState().data!.settings;
      observed.push([saved.useMemoryFacts, saved.referenceChatHistory, saved.learnAutomatically]);
    }

    expect(observed).toEqual(states);
    expect(new Set(observed.map((state) => state.join(""))).size).toBe(8);
    expect(patchBodies).toHaveLength(7);
  });

  it("persists locale without claiming a Memory revision", async () => {
    const initial = memorySettingsFixture({}, "RU");
    let body: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(memorySettingsFixture({
        settings: { ...initial.settings, memoryUiLocale: "EN", settingsRevision: 13 }
      }, "EN")), {
        headers: { "content-type": "application/json" },
        status: 200
      });
    }));
    useMemorySettingsStore.setState({ data: initial, error: null, loadState: "ready" });

    await updateMemoryLocale("EN");

    expect(body).toEqual({ expectedSettingsRevision: 12, memoryUiLocale: "EN" });
    expect(useMemorySettingsStore.getState().data?.settings.memoryUiLocale).toBe("EN");
  });

  it("binds destination acceptance to the exact current policy and revisions", async () => {
    const current = memorySettingsFixture({
      egress: {
        acceptedAt: null,
        acceptedUtilityEgressFingerprint: null,
        acceptedUtilityPolicyVersion: null,
        consentMode: "PER_USER",
        currentUtilityEgressFingerprint: "current-fingerprint-00000000000000001",
        reviewRequired: true
      }
    });
    let body: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(memorySettingsFixture()), {
        headers: { "content-type": "application/json" },
        status: 200
      });
    }));
    useMemorySettingsStore.setState({ data: current, error: null, loadState: "ready" });

    await acceptCurrentMemoryDestinations();

    expect(body).toEqual({
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      currentUtilityEgressFingerprint: "current-fingerprint-00000000000000001",
      currentUtilityPolicyVersion: "memory-policy-v1",
      expectedMemoryConsentRevision: 4,
      expectedMemoryRevision: 8,
      expectedSettingsRevision: 12
    });
  });

  it("reconciles current server state after stale settings authority", async () => {
    const initial = memorySettingsFixture();
    const current = memorySettingsFixture({
      settings: { ...initial.settings, settingsRevision: 18, memoryRevision: 14, useMemoryFacts: true }
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "memory_version_stale" }), {
        headers: { "content-type": "application/json" },
        status: 409
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(current), {
        headers: { "content-type": "application/json" },
        status: 200
      }));
    vi.stubGlobal("fetch", fetchMock);
    useMemorySettingsStore.setState({ data: initial, error: null, loadState: "ready" });

    await expect(updateMemoryGate("useMemoryFacts", true)).rejects.toThrow("memory_version_stale");

    expect(useMemorySettingsStore.getState().data).toEqual(current);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("deduplicates settings loads", async () => {
    const response = memorySettingsFixture();
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { resolve = done; })));

    const first = refreshMemorySettings();
    const second = refreshMemorySettings();
    resolve(new Response(JSON.stringify(response), {
      headers: { "content-type": "application/json" },
      status: 200
    }));

    await expect(Promise.all([first, second])).resolves.toEqual([response, response]);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
