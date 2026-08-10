import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authorizeMemoryMutation,
  loadMemorySettings,
  MemoryApiError,
  memoryStatementHash,
  searchMemories
} from "./memoryApi";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "@/lib/contracts/memory";
import { memoryListFixture, memorySettingsFixture } from "./memoryTestFixtures";

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
      scope: { type: "GLOBAL_USER" },
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
});
