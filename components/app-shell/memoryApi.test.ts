import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authorizeMemoryMutation,
  cancelMemoryRebuild,
  forgetMemory,
  loadMemoryHealth,
  loadMemorySettings,
  loadMemoryRebuildStatus,
  memoryStatementHash,
  searchMemories,
  startMemoryBulkDeletion,
  startMemoryRebuild,
  undoForgetMemory
} from "./memoryApi";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "@/lib/contracts/memory";
import {
  memoryDeletionFixture,
  memoryHealthFixture,
  memoryListFixture,
  memoryRebuildFixture,
  memorySettingsFixture,
  memorySummaryFixture
} from "@/tests/support/memoryFixtures";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status
  });
}

describe("Memory API client", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("strictly decodes settings and rejects an extra server field", async () => {
    const valid = memorySettingsFixture();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(valid), {
        headers: { "content-type": "application/json" },
        status: 200
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...valid, unexpected: true }), {
        headers: { "content-type": "application/json" },
        status: 200
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadMemorySettings()).resolves.toEqual(valid);
    await expect(loadMemorySettings()).rejects.toMatchObject({
      code: "memory_response_invalid",
      status: 502
    });
  });

  it("loads owner health with no-store semantics and rejects enriched evidence", async () => {
    const valid = { health: memoryHealthFixture() };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(valid))
      .mockResolvedValueOnce(jsonResponse({
        health: { ...valid.health, sourceChatId: "private-chat" }
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadMemoryHealth()).resolves.toEqual(valid);
    await expect(loadMemoryHealth()).rejects.toMatchObject({
      code: "memory_response_invalid",
      status: 502
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/me/memory/health");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
      method: "GET"
    });
  });

  it("keeps saved-memory search text out of URLs and strictly POSTs the bounded query", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(memoryListFixture()), {
      headers: { "content-type": "application/json" },
      status: 200
    }));
    vi.stubGlobal("fetch", fetchMock);

    await searchMemories("секретный любимый цвет");

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/me/memories/search");
    expect(path).not.toContain("секретный");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({
      pageSize: 20,
      query: "секретный любимый цвет",
      state: "ACTIVE"
    });
  });

  it("hashes the exact UTF-8 statement and mints current-copy single-action authority", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      expiresAt: "2026-08-10T08:05:00.000Z",
      mutationAuthorizationId: "memory-authorization-1"
    }), {
      headers: { "content-type": "application/json" },
      status: 201
    }));
    vi.stubGlobal("fetch", fetchMock);

    const statement = "  Ёж любит чай.  ";
    expect(await memoryStatementHash(statement)).toBe(
      "7790788b11cfc66c169250a7278043785ad2800cd67ac77245e3769d63fa10f5"
    );
    await authorizeMemoryMutation({ action: "SAVE", exactStatementHash: "a".repeat(64) });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/me/memory/mutation-authorizations");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      action: "SAVE",
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      exactStatementHash: "a".repeat(64)
    });
    expect(body.requestNonce).toMatch(/^[a-f0-9]{48}$/u);
  });

  it("exposes only stable Memory errors from failed responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "memory_version_stale",
      privateDetail: "must not escape"
    }), {
      headers: { "content-type": "application/json" },
      status: 409
    })));

    await expect(loadMemorySettings()).rejects.toMatchObject({
      code: "memory_action_failed",
      status: 409
    });
  });

  it("uses strict body-only operation routes and an explicitly empty cancel request", async () => {
    const deletion = memoryDeletionFixture({ operation: "CLEAR_HISTORY_INDEX" });
    const rebuild = memoryRebuildFixture();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(deletion), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(rebuild), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(rebuild), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...rebuild, state: "CANCELLED" }), {
        status: 200
      }));
    vi.stubGlobal("fetch", fetchMock);

    await startMemoryBulkDeletion({
      expectedMemoryRevision: 8,
      expectedSettingsRevision: 12,
      mutationAuthorizationId: "clear-authorization",
      operation: "CLEAR_HISTORY_INDEX"
    });
    await startMemoryRebuild({
      expectedMemoryRevision: 8,
      expectedSettingsRevision: 12,
      operation: "REBUILD_SEARCH_INDEX"
    });
    await loadMemoryRebuildStatus("job/private");
    await cancelMemoryRebuild("job/private");

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/me/memory/bulk-delete",
      "/api/me/memory/rebuild",
      "/api/me/memory/rebuild/job%2Fprivate",
      "/api/me/memory/rebuild/job%2Fprivate/cancel"
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "GET" });
    const cancelInit = fetchMock.mock.calls[3]?.[1] as RequestInit;
    expect(cancelInit.method).toBe("POST");
    expect(cancelInit.body).toBeUndefined();
    expect(new Headers(cancelInit.headers).get("content-type")).toBeNull();
  });

  it("strictly carries the owner-private Forget deadline into the exact Undo route", async () => {
    const active = memorySummaryFixture();
    const forgotten = memorySummaryFixture({
      currentVersionId: null,
      displayText: null,
      factState: "FORGOTTEN",
      versionState: "FORGOTTEN"
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        memory: forgotten,
        undo: {
          deletionId: "forget-deletion",
          expiresAt: "2026-08-11T08:01:00.000Z",
          versionId: "memory-version-1"
        }
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ memory: active }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(forgetMemory("memory/id", {
      expectedVersionId: "memory-version-1",
      mutationAuthorizationId: "forget-auth"
    })).resolves.toMatchObject({ undo: { deletionId: "forget-deletion" } });
    await expect(undoForgetMemory("memory/id", {
      deletionId: "forget-deletion",
      mutationAuthorizationId: "restore-auth"
    })).resolves.toEqual({ memory: active });

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/me/memories/memory%2Fid/forget",
      "/api/me/memories/memory%2Fid/undo-forget"
    ]);
  });
});
