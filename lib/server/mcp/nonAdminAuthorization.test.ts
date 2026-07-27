import type { AuthenticatedSession, RequestAuthResolver } from "@/lib/server/auth/requestAuth";
import { describe, expect, it, vi } from "vitest";
import {
  createAdminMcpActivateHandler,
  createAdminMcpCatalogHandler,
  createAdminMcpCheckUpdateHandler,
  createAdminMcpCreateHandler,
  createAdminMcpDeleteHandler,
  createAdminMcpDraftTestHandler,
  createAdminMcpGrantHandler,
  createAdminMcpRebuildHandler,
  createAdminMcpRollbackHandler,
  createAdminMcpUpdateHandler,
  createUserMcpUpdateHandler
} from "./handlers";
import type { McpRepository } from "./repositoryContract";

const SERVER_ID = "00000000-0000-4000-8000-000000000501";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const routeContext = { params: Promise.resolve({ serverId: SERVER_ID }) };

function session(): AuthenticatedSession {
  return {
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    id: "ordinary-session",
    user: {
      displayName: "MCP Member",
      email: "mcp-member@aiqsa.local",
      id: USER_ID,
      role: "user",
      status: "active"
    },
    userId: USER_ID
  };
}

function rejectingRepository(): McpRepository {
  const unexpected = vi.fn(async (): Promise<never> => {
    throw new Error("repository must not be reached");
  });
  return {
    activateDraft: unexpected,
    createServer: unexpected,
    deleteServer: unexpected,
    listAdminServers: unexpected,
    listUserServers: unexpected,
    rebuildRevision: unexpected,
    requestActivation: unexpected,
    rollbackServer: unexpected,
    setGrant: unexpected,
    testDraft: unexpected,
    updateServer: unexpected,
    updateUserServer: unexpected
  };
}

function jsonRequest(method: string, body: unknown = {}): Request {
  return new Request("https://aiqsa.example.test/api/admin/mcp", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method
  });
}

describe("ordinary-user MCP authorization", () => {
  it("rejects every admin catalog, definition, grant, and revision operation before storage", async () => {
    const repository = rejectingRepository();
    const resolveAuth: RequestAuthResolver = async () => session();
    const deps = { repository, resolveAuth };
    const cases: Array<() => Promise<Response>> = [
      () => createAdminMcpCatalogHandler(deps)(new Request("https://aiqsa.example.test/api/admin/mcp")),
      () => createAdminMcpCreateHandler(deps)(jsonRequest("POST", { draft: {}, name: "Forbidden" })),
      () => createAdminMcpUpdateHandler(deps)(jsonRequest("PATCH", { name: "Forbidden" }), routeContext),
      () => createAdminMcpDeleteHandler(deps)(new Request("https://aiqsa.example.test/api/admin/mcp", {
        method: "DELETE"
      }), routeContext),
      () => createAdminMcpDraftTestHandler(deps)(jsonRequest("POST"), routeContext),
      () => createAdminMcpCheckUpdateHandler(deps)(jsonRequest("POST"), routeContext),
      () => createAdminMcpActivateHandler(deps)(jsonRequest("POST"), routeContext),
      () => createAdminMcpRebuildHandler(deps)(jsonRequest("POST", {
        replaceDraft: false,
        revisionId: "revision-1"
      }), routeContext),
      () => createAdminMcpRollbackHandler(deps)(jsonRequest("POST", { revisionId: "revision-1" }), routeContext),
      () => createAdminMcpGrantHandler(deps)(jsonRequest("PUT", {
        canUse: true,
        personalSlotKeys: [],
        userId: USER_ID
      }), routeContext)
    ];

    for (const invoke of cases) {
      const response = await invoke();
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: "forbidden" });
    }
    for (const operation of Object.values(repository)) {
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it("takes the user identity only from the session when updating personal values", async () => {
    const calls: Array<Parameters<McpRepository["updateUserServer"]>[0]> = [];
    const repository = rejectingRepository();
    repository.updateUserServer = async (input) => {
      calls.push(input);
      return { kind: "not_found" as const };
    };
    const resolveAuth: RequestAuthResolver = async () => session();
    const update = createUserMcpUpdateHandler({ repository, resolveAuth });
    const response = await update(jsonRequest("PATCH", {
      enabled: true,
      serverId: "attacker-selected-server",
      userId: "another-user",
      values: { workspace: "member-workspace" }
    }), routeContext);

    expect(response.status).toBe(404);
    expect(calls).toEqual([{
      enabled: true,
      serverId: SERVER_ID,
      userId: USER_ID,
      values: { workspace: "member-workspace" }
    }]);
  });
});
