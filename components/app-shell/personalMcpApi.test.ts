import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConnectorCatalog, loadPersonalMcpConnections, PersonalMcpApiError } from "./personalMcpApi";

afterEach(() => vi.unstubAllGlobals());

describe("Personal MCP API decoding", () => {
  it("rejects a malformed server instead of treating it as an empty catalog", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ servers: [{}] })));
    await expect(loadPersonalMcpConnections()).rejects.toEqual(new PersonalMcpApiError("mcp_response_invalid", 502));
  });

  it("accepts a personal server that carries no runtime-session status", async () => {
    const server = {
      accountLabel: null, description: "Synthetic personal MCP", enabled: true, fields: [], id: "personal-1",
      knownToolCount: 1, name: "Synthetic personal MCP", oauthAvailable: false, oauthState: null,
      readiness: "idle", sourceType: "personal", tools: [{ description: "Echo", name: "echo" }]
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ servers: [server] })));
    const [loaded] = await loadPersonalMcpConnections();
    expect(loaded).toMatchObject({ id: "personal-1", knownToolCount: 1, readiness: "idle", enabled: true });
  });

  it("rejects a malformed connector entry instead of hiding the catalog", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ connectors: [{ id: "gmail" }] })));
    await expect(loadConnectorCatalog()).rejects.toEqual(new PersonalMcpApiError("connector_response_invalid", 502));
  });
});
