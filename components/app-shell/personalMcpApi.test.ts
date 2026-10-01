import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConnectorCatalog, loadPersonalMcpConnections, PersonalMcpApiError } from "./personalMcpApi";

afterEach(() => vi.unstubAllGlobals());

describe("Personal MCP API decoding", () => {
  it("rejects a malformed server instead of treating it as an empty catalog", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ servers: [{}] })));
    await expect(loadPersonalMcpConnections()).rejects.toEqual(new PersonalMcpApiError("mcp_response_invalid", 502));
  });

  it("rejects a malformed connector entry instead of hiding the catalog", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ connectors: [{ id: "gmail" }] })));
    await expect(loadConnectorCatalog()).rejects.toEqual(new PersonalMcpApiError("connector_response_invalid", 502));
  });
});
