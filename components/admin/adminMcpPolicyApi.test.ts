import { describe, expect, it, vi } from "vitest";
import { adminMcpPolicyErrorMessage, getAdminMcpPolicy, updateAdminMcpPolicy } from "./adminMcpPolicyApi";

describe("admin MCP policy API", () => {
  it("decodes a read and sends the change with the version it replaces", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ policy: { personalLocalNetworkEnabled: true, version: 4 } }))
      .mockResolvedValueOnce(Response.json({ policy: { personalLocalNetworkEnabled: false, version: 5 } }));

    await expect(getAdminMcpPolicy(fetcher)).resolves.toEqual({ data: { personalLocalNetworkEnabled: true, version: 4 }, ok: true });
    await expect(updateAdminMcpPolicy({ personalLocalNetworkEnabled: false, version: 4 }, fetcher))
      .resolves.toEqual({ data: { personalLocalNetworkEnabled: false, version: 5 }, ok: true });
    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/admin/mcp/policy", { cache: "no-store", credentials: "same-origin", method: "GET" });
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/admin/mcp/policy", {
      body: JSON.stringify({ personalLocalNetworkEnabled: false, version: 4 }),
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      method: "PATCH"
    });
  });

  it("keeps stable error codes and rejects malformed success", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "mcp_policy_stale" }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ policy: { personalLocalNetworkEnabled: "yes", version: 4 } }))
      .mockResolvedValueOnce(new Response("gateway", { status: 502 }))
      .mockRejectedValueOnce(new TypeError("offline"));

    await expect(updateAdminMcpPolicy({ personalLocalNetworkEnabled: true, version: 3 }, fetcher))
      .resolves.toEqual({ error: "mcp_policy_stale", ok: false });
    await expect(getAdminMcpPolicy(fetcher)).resolves.toEqual({ error: "mcp_policy_response_invalid", ok: false });
    await expect(getAdminMcpPolicy(fetcher)).resolves.toEqual({ error: "mcp_policy_failed", ok: false });
    await expect(getAdminMcpPolicy(fetcher)).resolves.toEqual({ error: "network_error", ok: false });
  });

  it("explains each stable error and falls back for unknown ones", () => {
    expect(adminMcpPolicyErrorMessage("mcp_policy_stale")).toMatch(/changed in another session/u);
    expect(adminMcpPolicyErrorMessage("private upstream detail")).toBe("The personal connection setting could not be updated.");
    expect(adminMcpPolicyErrorMessage("mcp_not_found", "read")).toBe("The personal connection setting could not be loaded.");
  });
});
