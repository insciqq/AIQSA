import { describe, expect, it, vi } from "vitest";
import type { RequestAuthResolver } from "@/lib/server/auth/requestAuth";
import { createMcpPolicyHandlers } from "./policyHandlers";
import { createPrismaMcpPolicyRepository, type McpPolicyRepository } from "./policyRepository";

function auth(role: "admin" | "user" | null, status = "active"): RequestAuthResolver {
  return (async () => role ? { user: { id: "admin-1", role, status }, userId: "admin-1" } : null) as unknown as RequestAuthResolver;
}

function repository(overrides: Partial<McpPolicyRepository> = {}): McpPolicyRepository {
  return {
    read: vi.fn(async () => ({ personalLocalNetworkEnabled: true, version: 4 })),
    update: vi.fn(async (input) => ({ kind: "ok" as const, policy: { personalLocalNetworkEnabled: input.personalLocalNetworkEnabled, version: input.expectedVersion + 1 } })),
    ...overrides
  };
}

function patch(body: unknown, contentType = "application/json") {
  return new Request("https://aiqsa.test/api/admin/mcp/policy", {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": contentType },
    method: "PATCH"
  });
}

const get = () => new Request("https://aiqsa.test/api/admin/mcp/policy");

describe("admin MCP policy handlers", () => {
  it("reads the policy for an active administrator without caching", async () => {
    const handlers = createMcpPolicyHandlers({ repository: repository(), resolveAuth: auth("admin") });
    const response = await handlers.GET(get());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ policy: { personalLocalNetworkEnabled: true, version: 4 } });
  });

  it.each([
    [null, "active", 401, "unauthorized"],
    ["user", "active", 403, "forbidden"],
    ["admin", "disabled", 403, "forbidden"]
  ] as const)("refuses %s (%s) with %s", async (role, status, httpStatus, error) => {
    const store = repository();
    const handlers = createMcpPolicyHandlers({ repository: store, resolveAuth: auth(role, status) });
    for (const response of [await handlers.GET(get()), await handlers.PATCH(patch({ personalLocalNetworkEnabled: false, version: 4 }))]) {
      expect(response.status).toBe(httpStatus);
      expect(await response.json()).toEqual({ error });
    }
    expect(store.read).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
  });

  it("switches the policy at the version read and applies the change to running connections", async () => {
    const store = repository();
    const onUpdated = vi.fn();
    const handlers = createMcpPolicyHandlers({ onUpdated, repository: store, resolveAuth: auth("admin") });
    const response = await handlers.PATCH(patch({ personalLocalNetworkEnabled: false, version: 4 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ policy: { personalLocalNetworkEnabled: false, version: 5 } });
    expect(store.update).toHaveBeenCalledWith({ expectedVersion: 4, personalLocalNetworkEnabled: false });
    expect(onUpdated).toHaveBeenCalledWith({ personalLocalNetworkEnabled: false, version: 5 });
  });

  it("answers a concurrent change as stale without applying anything", async () => {
    const onUpdated = vi.fn();
    const handlers = createMcpPolicyHandlers({
      onUpdated,
      repository: repository({ update: vi.fn(async () => ({ kind: "stale" as const })) }),
      resolveAuth: auth("admin")
    });
    const response = await handlers.PATCH(patch({ personalLocalNetworkEnabled: true, version: 3 }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "mcp_policy_stale" });
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it.each([
    [{ personalLocalNetworkEnabled: false }, "a missing version"],
    [{ version: 4 }, "a missing value"],
    [{ personalLocalNetworkEnabled: "false", version: 4 }, "a string value"],
    [{ personalLocalNetworkEnabled: false, version: 0 }, "a zero version"],
    [{ personalLocalNetworkEnabled: false, version: 1.5 }, "a fractional version"],
    [{ expectedVersion: 4, personalLocalNetworkEnabled: false }, "an unknown key"],
    [[false], "an array"],
    ["not json", "malformed JSON"]
  ])("rejects %j (%s) before any write", async (body, _label) => {
    const store = repository();
    const response = await createMcpPolicyHandlers({ repository: store, resolveAuth: auth("admin") }).PATCH(patch(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "mcp_policy_input_invalid" });
    expect(store.update).not.toHaveBeenCalled();
  });

  it("requires JSON", async () => {
    const response = await createMcpPolicyHandlers({ repository: repository(), resolveAuth: auth("admin") })
      .PATCH(patch("personalLocalNetworkEnabled=false", "application/x-www-form-urlencoded"));
    expect(response.status).toBe(415);
  });

  it("fails visibly and content-free when storage is unavailable", async () => {
    const lines: string[] = [];
    const writer = vi.spyOn(process.stdout, "write").mockImplementation((line) => { lines.push(String(line)); return true; });
    try {
      const failing = repository({
        read: vi.fn(async () => { throw new Error("connect ECONNREFUSED private-host:5432"); }),
        update: vi.fn(async () => { throw new Error("connect ECONNREFUSED private-host:5432"); })
      });
      const handlers = createMcpPolicyHandlers({ repository: failing, resolveAuth: auth("admin") });
      for (const response of [await handlers.GET(get()), await handlers.PATCH(patch({ personalLocalNetworkEnabled: true, version: 4 }))]) {
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: "mcp_policy_unavailable" });
      }
      expect(lines.join("")).not.toContain("private-host");
    } finally {
      writer.mockRestore();
    }
  });

  it("keeps the committed answer when applying the change throws", async () => {
    const handlers = createMcpPolicyHandlers({
      onUpdated: () => { throw new Error("runtime unavailable"); },
      repository: repository(),
      resolveAuth: auth("admin")
    });
    const response = await handlers.PATCH(patch({ personalLocalNetworkEnabled: true, version: 4 }));
    expect(response.status).toBe(200);
  });
});

describe("MCP policy repository", () => {
  function prisma(input: Readonly<{ updated: number }>) {
    const calls: string[] = [];
    const tx = {
      mcpPolicy: {
        findUniqueOrThrow: vi.fn(async () => ({ personalLocalNetworkEnabled: true, version: 5 })),
        updateMany: vi.fn(async (args: unknown) => { calls.push(`policy ${JSON.stringify(args)}`); return { count: input.updated }; })
      },
      mcpRuntimeGeneration: {
        updateMany: vi.fn(async (args: unknown) => { calls.push(`generations ${JSON.stringify(args)}`); return { count: 2 }; })
      }
    };
    const client = {
      $transaction: vi.fn(async (operation: (transaction: typeof tx) => Promise<unknown>) => operation(tx)),
      mcpPolicy: { findUnique: vi.fn(async () => null) }
    };
    return { calls, client, tx };
  }

  it("updates only at the expected version and lets refused runtimes reconnect at once when turned on", async () => {
    const { calls, client } = prisma({ updated: 1 });
    const store = createPrismaMcpPolicyRepository(client as never);
    await expect(store.update({ expectedVersion: 4, personalLocalNetworkEnabled: true }))
      .resolves.toEqual({ kind: "ok", policy: { personalLocalNetworkEnabled: true, version: 5 } });
    expect(calls).toEqual([
      `policy ${JSON.stringify({
        data: { personalLocalNetworkEnabled: true, version: { increment: 1 } },
        where: { id: "installation", version: 4 }
      })}`,
      `generations ${JSON.stringify({
        data: { retryAt: null },
        where: { errorCode: "mcp_local_network_disabled", state: "failed" }
      })}`
    ]);
  });

  it("touches no runtime when turning off or when stale", async () => {
    const off = prisma({ updated: 1 });
    await createPrismaMcpPolicyRepository(off.client as never).update({ expectedVersion: 4, personalLocalNetworkEnabled: false });
    expect(off.tx.mcpRuntimeGeneration.updateMany).not.toHaveBeenCalled();
    const stale = prisma({ updated: 0 });
    await expect(createPrismaMcpPolicyRepository(stale.client as never).update({ expectedVersion: 3, personalLocalNetworkEnabled: true }))
      .resolves.toEqual({ kind: "stale" });
    expect(stale.tx.mcpRuntimeGeneration.updateMany).not.toHaveBeenCalled();
  });

  it("fails closed on a missing singleton", async () => {
    const { client } = prisma({ updated: 1 });
    await expect(createPrismaMcpPolicyRepository(client as never).read()).rejects.toThrow("mcp_policy_integrity_invalid");
  });
});
