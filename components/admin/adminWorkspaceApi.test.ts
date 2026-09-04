import { describe, expect, it, vi } from "vitest";
import {
  adminWorkspaceErrorMessage,
  getAdminWorkspacePolicy,
  updateAdminWorkspacePolicy
} from "./adminWorkspaceApi";

const policy = {
  workspace: {
    enabled: false,
    internetEnabled: true,
    runtime: {
      imageReady: true,
      mcpVersion: "0.6.16",
      runtimeVersion: "0.6.16",
      state: "ready",
      virtualizationReady: true
    },
    version: 2
  }
};

describe("admin Workspace API", () => {
  it("decodes reads and sends an optimistic bounded update", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(policy), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        workspace: { ...policy.workspace, enabled: true, version: 3 }
      }), { status: 200 }));

    await expect(getAdminWorkspacePolicy(fetcher)).resolves.toEqual({
      data: policy.workspace,
      ok: true
    });
    await expect(updateAdminWorkspacePolicy(2, { enabled: true }, fetcher)).resolves.toEqual({
      data: { ...policy.workspace, enabled: true, version: 3 },
      ok: true
    });
    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/admin/workspace", {
      cache: "no-store",
      credentials: "same-origin",
      method: "GET"
    });
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/admin/workspace", {
      body: JSON.stringify({ expectedVersion: 2, enabled: true }),
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      method: "PATCH"
    });
  });

  it("fails closed on malformed success bodies and humanizes stable errors", async () => {
    const malformed = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ workspace: { enabled: true } }), { status: 200 })
    );
    const stale = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "workspace_policy_stale" }), { status: 409 })
    );

    await expect(getAdminWorkspacePolicy(malformed)).resolves.toEqual({
      error: "workspace_policy_response_invalid",
      ok: false
    });
    await expect(updateAdminWorkspacePolicy(2, { internetEnabled: false }, stale)).resolves.toEqual({
      error: "workspace_policy_stale",
      ok: false
    });
    expect(adminWorkspaceErrorMessage("workspace_policy_stale")).toMatch(/another session/iu);
  });
});
