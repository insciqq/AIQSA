import { describe, expect, it, vi } from "vitest";
import { requestAdminAttention, requestAdminAttentionSummary } from "./adminAttentionApi";

const attention = {
  checkedAt: "2026-09-07T12:00:00.000Z",
  items: [],
  unavailable: []
};

describe("requestAdminAttention", () => {
  it("decodes a well-formed response and rejects malformed ones as failures", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ attention }));
    await expect(requestAdminAttention(fetcher)).resolves.toEqual({ attention, ok: true });
    expect(fetcher).toHaveBeenCalledWith("/api/admin/attention", { method: "GET" });

    fetcher.mockResolvedValue(Response.json({ attention: { items: "no" } }));
    await expect(requestAdminAttention(fetcher)).resolves.toEqual({ error: "admin_attention_failed", ok: false });
  });

  it("maps auth failures, server failures and network errors to stable codes", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "forbidden" }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ error: "admin_attention_failed" }, { status: 500 }))
      .mockRejectedValueOnce(new Error("offline"));
    await expect(requestAdminAttention(fetcher)).resolves.toEqual({ error: "forbidden", ok: false });
    await expect(requestAdminAttention(fetcher)).resolves.toEqual({ error: "admin_attention_failed", ok: false });
    await expect(requestAdminAttention(fetcher)).resolves.toEqual({ error: "network_error", ok: false });
  });
});

describe("requestAdminAttentionSummary", () => {
  const summary = { bad: 1, checkedAt: "2026-10-07T12:00:00.000Z", health: null, unavailable: ["health"], warn: 2 };

  it("decodes the badge counts and rejects malformed or negative counts", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ summary }));
    await expect(requestAdminAttentionSummary(fetcher)).resolves.toEqual({ ok: true, summary });
    expect(fetcher).toHaveBeenCalledWith("/api/admin/attention/summary", { method: "GET" });

    fetcher.mockResolvedValue(Response.json({ summary: { ...summary, bad: -1 } }));
    await expect(requestAdminAttentionSummary(fetcher)).resolves.toEqual({ error: "admin_attention_failed", ok: false });
    fetcher.mockResolvedValue(Response.json({ summary: { ...summary, unavailable: ["secrets"] } }));
    await expect(requestAdminAttentionSummary(fetcher)).resolves.toEqual({ error: "admin_attention_failed", ok: false });
  });

  it("maps a non-administrator and transport failures to stable codes", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "forbidden" }, { status: 403 }))
      .mockRejectedValueOnce(new Error("offline"));
    await expect(requestAdminAttentionSummary(fetcher)).resolves.toEqual({ error: "forbidden", ok: false });
    await expect(requestAdminAttentionSummary(fetcher)).resolves.toEqual({ error: "network_error", ok: false });
  });
});
