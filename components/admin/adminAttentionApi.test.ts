import { describe, expect, it, vi } from "vitest";
import { requestAdminAttention } from "./adminAttentionApi";

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
