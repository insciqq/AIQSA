import { describe, expect, it, vi } from "vitest";
import {
  getAdminMemoryStatus,
  startAdminMemoryRebuild,
  updateAdminMemoryAdmissionTimeout
} from "./adminMemoryApi";

function response() {
  return {
    memory: {
      admissionTimeout: { seconds: 15, version: 4 },
      activeIssueCode: null,
      configuredTargets: [{ model: "Utility", provider: "Primary" }],
      index: { generation: 2, readiness: "READY" },
      queue: { length: 0, oldestAgeSeconds: null },
      rebuild: { state: "NOT_REQUIRED" },
      worker: { state: "RUNNING" }
    }
  };
}

describe("administrator Memory API", () => {
  it("loads minimal status and admits the one rebuild command", async () => {
    const fetcher = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit
    ) => Response.json(response()));
    await expect(getAdminMemoryStatus(fetcher)).resolves.toEqual({
      data: response(),
      ok: true
    });
    await expect(startAdminMemoryRebuild(fetcher)).resolves.toMatchObject({ ok: true });
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/admin/memory");
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify({ action: "REBUILD_REQUIRED" }),
      method: "POST"
    });
    await expect(updateAdminMemoryAdmissionTimeout(4, 30, fetcher))
      .resolves.toMatchObject({ ok: true });
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({
      body: JSON.stringify({ expectedVersion: 4, timeoutSeconds: 30 }),
      method: "PUT"
    });
  });

  it("rejects detailed or malformed server projections", async () => {
    const detailed = {
      ...response(),
      memoryEgress: { currentFingerprint: "a".repeat(64) }
    };
    await expect(getAdminMemoryStatus(vi.fn().mockResolvedValue(
      Response.json(detailed)
    ))).resolves.toEqual({
      error: "memory_admin_status_response_invalid",
      ok: false
    });
  });

  it("preserves bounded server and network errors", async () => {
    await expect(startAdminMemoryRebuild(vi.fn().mockResolvedValue(
      Response.json({ error: "memory_admin_rebuild_unavailable" }, { status: 409 })
    ))).resolves.toEqual({
      error: "memory_admin_rebuild_unavailable",
      ok: false
    });
    await expect(getAdminMemoryStatus(vi.fn().mockRejectedValue(new Error("offline"))))
      .resolves.toEqual({ error: "network_error", ok: false });
  });
});
