import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMemory,
  forgetMemory,
  listMemories,
  loadMemorySettings,
  patchMemorySettings,
  resetPersonalMemory,
  searchMemories,
  submitMemorySourceAction,
  updateMemory
} from "./memoryApi";
import { MEMORY_CONSUMER_CONFIRMATION_COPY_VERSION } from "@/lib/contracts/memoryConsumer";
import {
  memoryConsumerItemFixture,
  memoryConsumerListFixture,
  memoryConsumerSettingsFixture
} from "@/tests/support/memoryFixtures";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Memory consumer API", () => {
  it("strictly accepts only the safe settings projection", async () => {
    const settings = memoryConsumerSettingsFixture();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json(settings))
      .mockResolvedValueOnce(json({ ...settings, memoryRevision: 12 })));

    await expect(loadMemorySettings()).resolves.toEqual(settings);
    await expect(loadMemorySettings()).rejects.toMatchObject({
      code: "memory_response_invalid",
      status: 502
    });
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/me/memory/settings", expect.objectContaining({
      cache: "no-store",
      credentials: "same-origin",
      method: "GET"
    }));
  });

  it("patches only the selected setting without browser-owned revisions", async () => {
    const settings = memoryConsumerSettingsFixture({
      settings: { useMemoryFacts: true },
      status: "ON"
    });
    const fetchMock = vi.fn().mockResolvedValue(json(settings));
    vi.stubGlobal("fetch", fetchMock);

    await expect(patchMemorySettings({ useMemoryFacts: true })).resolves.toEqual(settings);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ useMemoryFacts: true });
    expect(String(init.body)).not.toMatch(/revision|generation|fingerprint/iu);
  });

  it("keeps private search text out of the URL and decodes opaque item refs", async () => {
    const response = memoryConsumerListFixture();
    const fetchMock = vi.fn().mockResolvedValue(json(response));
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchMemories(
      "секретный любимый цвет",
      null,
      undefined,
      { category: "PREFERENCES", provenance: "LEARNED" }
    )).resolves.toEqual(response);

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/me/memories/search");
    expect(path).not.toContain("секретный");
    expect(JSON.parse(String(init.body))).toEqual({
      category: "PREFERENCES",
      pageSize: 20,
      provenance: "LEARNED",
      query: "секретный любимый цвет"
    });
  });

  it("uses opaque refs and server-minted authority for create, edit, and forget", async () => {
    const created = memoryConsumerItemFixture({ memoryRef: "opaque-ref-created" });
    const edited = memoryConsumerItemFixture({
      memoryRef: "opaque-ref-edited",
      statement: "Use concise answers."
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ item: created }, 201))
      .mockResolvedValueOnce(json({ item: edited }))
      .mockResolvedValueOnce(json({ status: "FORGOTTEN" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createMemory("I prefer concise answers.")).resolves.toEqual({ item: created });
    await expect(updateMemory("opaque/ref", "Use concise answers.")).resolves.toEqual({ item: edited });
    await expect(forgetMemory("opaque/ref")).resolves.toEqual({ status: "FORGOTTEN" });

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/me/memories",
      "/api/me/memories/opaque%2Fref",
      "/api/me/memories/opaque%2Fref/forget"
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
      expect(body.requestId).toMatch(/^[a-f0-9]{48}$/u);
      expect(JSON.stringify(body)).not.toMatch(/factId|versionId|authorization|hash/iu);
    }
  });

  it("lists with opaque cursors and rejects enriched item responses", async () => {
    const response = memoryConsumerListFixture([], "opaque-next-cursor");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json(response))
      .mockResolvedValueOnce(json({
        items: [{ ...memoryConsumerItemFixture(), score: 0.98 }],
        nextCursor: null
      })));

    await expect(listMemories(
      "opaque-cursor",
      undefined,
      { category: "WORK", provenance: "SAVED" }
    )).resolves.toEqual(response);
    await expect(listMemories()).rejects.toMatchObject({ code: "memory_response_invalid" });
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/api/me/memories?pageSize=20&category=WORK&cursor=opaque-cursor&provenance=SAVED",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("resets through the single product action without deletion IDs or revisions", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ status: "IN_PROGRESS" }, 202));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resetPersonalMemory()).resolves.toEqual({ status: "IN_PROGRESS" });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/me/memory/reset");
    expect(JSON.parse(String(init.body))).toEqual({
      confirmationCopyVersion: MEMORY_CONSUMER_CONFIRMATION_COPY_VERSION,
      requestId: expect.stringMatching(/^[a-f0-9]{48}$/u)
    });
    expect(String(init.body)).not.toMatch(/deletion|revision|generation|authorization/iu);
  });

  it("keeps source actions on opaque refs and fails closed on unsafe navigation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ status: "COMMITTED" }))
      .mockResolvedValueOnce(json({
        href: "/api/me/memory/source-actions/open?memoryRef=opaque-ref",
        status: "READY"
      }))
      .mockResolvedValueOnce(json({ href: "javascript:alert(1)", status: "READY" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitMemorySourceAction("CORRECT", " opaque-ref ", "Corrected statement"))
      .resolves.toEqual({ status: "COMMITTED" });
    await expect(submitMemorySourceAction("OPEN_SOURCE", "opaque-ref"))
      .resolves.toEqual({
        href: "/api/me/memory/source-actions/open?memoryRef=opaque-ref",
        status: "READY"
      });
    await expect(submitMemorySourceAction("OPEN_SOURCE", "opaque-ref"))
      .rejects.toMatchObject({ code: "memory_response_invalid", status: 502 });

    const firstBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(firstBody).toMatchObject({
      action: "CORRECT",
      memoryRef: "opaque-ref",
      statement: "Corrected statement"
    });
    expect(firstBody.requestNonce).toMatch(/^[a-f0-9]{48}$/u);
  });
});
