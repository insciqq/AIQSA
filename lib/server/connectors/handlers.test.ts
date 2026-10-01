import { describe, expect, it, vi } from "vitest";
import type { McpRepository } from "@/lib/server/mcp/repositoryContract";
import type { RequestAuthResolver } from "@/lib/server/auth/requestAuth";
import { createConnectorCatalogHandler, createConnectorConnectHandler } from "./handlers";

function deps(configured = false) {
  return {
    getConfig: () => ({ mcpConnectorOAuth: configured ? { gmail: { clientId: "synthetic-client", clientSecret: "synthetic-secret" } } : {} }),
    repository: { listUserServers: vi.fn(async () => []), createPersonalServer: vi.fn(async () => ({ kind: "ok", value: { id: "server-1", connectorKey: "gmail" } })) } as unknown as McpRepository,
    resolveAuth: vi.fn(async () => ({ userId: "owner" })) as unknown as RequestAuthResolver
  };
}

describe("first-party connector handlers", () => {
  it("shows setup state without exposing client credentials", async () => {
    const input = deps(true);
    const response = await createConnectorCatalogHandler(input)(new Request("https://app.example.test/api/me/connectors"));
    const payload = await response.json();
    expect(payload.connectors.find((entry: {id: string}) => entry.id === "gmail").status).toBe("preview");
    expect(payload.connectors.find((entry: {id: string}) => entry.id === "github").status).toBe("unavailable");
    expect(payload.connectors.find((entry: {id: string}) => entry.id === "notion").status).toBe("available");
    expect(JSON.stringify(payload)).not.toContain("synthetic-");
  });

  it("does not create a connection for a provider missing its registered client", async () => {
    const input = deps();
    const response = await createConnectorConnectHandler(input)(new Request("https://app.example.test/api/me/connectors/gmail", { method: "POST" }), { params: { connectorId: "gmail" } });
    expect(response.status).toBe(503);
    expect(input.repository.createPersonalServer).not.toHaveBeenCalled();
  });

  it("uses the shared callback start path for a configured provider", async () => {
    const input = deps(true);
    const response = await createConnectorConnectHandler(input)(new Request("https://app.example.test/api/me/connectors/gmail", { method: "POST" }), { params: { connectorId: "gmail" } });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ oauthAction: "/api/me/connectors/oauth/connect?server=server-1" });
    expect(input.repository.createPersonalServer).toHaveBeenCalledWith(expect.objectContaining({ connectorKey: "gmail", userId: "owner" }));
  });
});
