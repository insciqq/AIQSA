import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPersonalMcpConnections, PersonalMcpApiError } from "./personalMcpApi";

afterEach(() => vi.unstubAllGlobals());

describe("Personal MCP API decoding", () => {
  it("rejects a malformed server instead of treating it as an empty catalog", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ servers: [{}] })));
    await expect(loadPersonalMcpConnections()).rejects.toEqual(new PersonalMcpApiError("mcp_response_invalid", 502));
  });
});
