import { filterMcpProviderRequest } from "./toolAccessProjection";
import { mcpFindToolsTool } from "./discovery";
import { mcpRunTools } from "./toolExecutor";
import type { ProviderRunRequest } from "../providers/types";
import type { McpRunPlanSnapshot } from "./runPlan";
import { describe, expect, it, vi } from "vitest";
import { decodeMcpToolAccessPolicy } from "@/lib/contracts/mcp";
import { assertMcpToolAccess, filterMcpToolsForUser, resolveMcpToolAccess } from "./toolAccess";

const tool = { serverId: "tracker", originalName: "issue_update" };
const actor = { id: "alice", active: true, groupIds: ["editors", "full-access"] };
const policy = { serverId: "tracker", toolName: "issue_update", restricted: true, users: [], groups: [] };

describe("optional MCP tool access", () => {
  it("inherits by default and when disabled, while restricted + empty denies everyone", () => {
    expect(resolveMcpToolAccess(actor, [])(tool)).toBe(true);
    expect(resolveMcpToolAccess(actor, [{ ...policy, restricted: false }])(tool)).toBe(true);
    expect(resolveMcpToolAccess(actor, [policy])(tool)).toBe(false);
    expect(resolveMcpToolAccess({ ...actor, id: "admin" }, [policy])(tool)).toBe(false);
    expect(resolveMcpToolAccess({ ...actor, active: false }, [])(tool)).toBe(false);
  });

  it("unions explicit user and active group grants without an implicit Full access bypass", () => {
    for (const recipients of [
      { users: [{ userId: "alice" }] },
      { groups: [{ groupId: "editors" }] },
      { groups: [{ groupId: "full-access" }] },
      { users: [{ userId: "bob" }], groups: [{ groupId: "missing" }, { groupId: "editors" }] }
    ]) expect(resolveMcpToolAccess(actor, [{ ...policy, ...recipients }])(tool)).toBe(true);
    expect(resolveMcpToolAccess(actor, [{ ...policy, users: [{ userId: "bob" }] }])(tool)).toBe(false);
    expect(resolveMcpToolAccess({ ...actor, groupIds: [] }, [{ ...policy, groups: [{ groupId: "editors" }] }])(tool)).toBe(false);
  });

  it("keys by exact server and original name, with no wildcard or rename inference", () => {
    const allowed = resolveMcpToolAccess(actor, [policy]);
    expect(allowed({ ...tool, serverId: "another-tracker" })).toBe(true);
    expect(allowed({ ...tool, originalName: "issue_update_v2" })).toBe(true);
    expect(allowed({ ...tool, originalName: "ISSUE_UPDATE" })).toBe(true);
    expect(allowed(tool)).toBe(false);
  });

  it("loads memberships and all server policies in batches and rechecks after revocation", async () => {
    let policies = [{ ...policy, users: [{ userId: "alice" }] }];
    const user = { findUnique: vi.fn(async () => ({ status: "active", groups: [{ groupId: "editors" }] })) };
    const findMany = vi.fn(async () => policies);
    const client = { user, mcpToolAccessPolicy: { findMany } } as unknown as Parameters<typeof assertMcpToolAccess>[0];
    const tools = [tool, { ...tool, originalName: "issue_get" }];
    expect(await filterMcpToolsForUser("alice", tools, client)).toEqual(tools);
    policies = [{ ...policy, users: [] }];
    expect(await filterMcpToolsForUser("alice", tools, client)).toEqual([tools[1]]);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(user.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({ groups: { select: { groupId: true }, where: { group: { archivedAt: null } } } })
    }));
    await expect(assertMcpToolAccess(client, "alice", tools)).rejects.toMatchObject({ code: "mcp_tool_access_denied" });
  });

  it("bounds recipients, rejects malformed mode and preserves exact identity", () => {
    const valid = { name: "issue_update", restricted: true, userIds: ["b", "a", "a"], groupIds: [] };
    expect(decodeMcpToolAccessPolicy(valid)).toEqual({ ...valid, userIds: ["a", "b"] });
    for (const invalid of [null, {}, { ...valid, restricted: "true" }, { ...valid, name: "" },
      { ...valid, userIds: [" "] }, { ...valid, groupIds: Array(257).fill("group") },
      { ...valid, userIds: ["a".repeat(129)] }, { ...valid, groupIds: [42] }]) {
      expect(decodeMcpToolAccessPolicy(invalid)).toBeNull();
    }
  });
});


it("removes revoked schemas while keeping built-in discovery and immutable accepted evidence", async () => {
  const snapshot: McpRunPlanSnapshot = { version: 1, servers: [{ serverId: "tracker", serverName: "Tracker", fingerprint: "a".repeat(64), revisionId: "rev" }],
    tools: ["read", "write"].map((name) => ({ serverId: "tracker", serverName: "Tracker", name, originalName: name,
      namespacedName: `mcp_tracker_${name}`, description: null, definitionHash: "b".repeat(64), inputSchema: { type: "object" } })) };
  const request = { mcp: snapshot, tools: [mcpFindToolsTool, ...mcpRunTools(snapshot)],
    mcpDiscovery: { version: 2, epochs: [], catalog: { version: 1, servers: [{ serverId: "tracker", serverName: "Tracker", namespace: "tracker", revisionId: "rev", description: "",
      tools: snapshot.tools.map(({ originalName, namespacedName, description }) => ({ originalName, namespacedName, description })) }] } } } as unknown as ProviderRunRequest;
  const original = structuredClone(request);
  const filtered = await filterMcpProviderRequest(request, "alice", async (_userId, tools) => tools.filter(({ originalName }) => originalName !== "write"));
  expect(filtered.tools?.map(({ name }) => name)).toEqual(["find_tools", "mcp_tracker_read"]);
  expect(filtered.mcp?.tools.map(({ originalName }) => originalName)).toEqual(["read"]);
  expect(filtered.mcpDiscovery?.catalog.servers[0]?.tools.map(({ originalName }) => originalName)).toEqual(["read"]);
  expect(request).toEqual(original);
  const empty = await filterMcpProviderRequest(request, "alice", async () => []);
  expect(empty.tools?.map(({ name }) => name)).toEqual(["find_tools"]);
  expect(empty.mcpDiscovery?.catalog.servers).toEqual([]);
});
