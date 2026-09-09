import { describe, expect, it } from "vitest";
import { decodeAdminModelPolicyResponse } from "./adminModelPolicy";

describe("administrator model policy contract", () => {
  it("decodes positive safe tool budgets without an arbitrary product cap", () => {
    expect(decodeAdminModelPolicyResponse({
      modelPolicy: {
        candidates: [],
        policy: {
          defaultModel: null,
          reasoningEffort: null,
          mcpAutoDiscoveryTimeoutSeconds: 60, mcpAutoDiscoveryMaxOutputTokens: 8192,
          maxMcpToolsPerDiscovery: 10,
          maxToolCalls: 200,
          maxToolRounds: 200,
          updatedAt: "2026-08-17T00:00:00.000Z",
          updatedBy: null,
          version: 1
        }
      }
    })?.modelPolicy.policy).toMatchObject({
      mcpAutoDiscoveryTimeoutSeconds: 60, mcpAutoDiscoveryMaxOutputTokens: 8192,
      maxMcpToolsPerDiscovery: 10,
      maxToolCalls: 200,
      maxToolRounds: 200
    });
  });

  it.each([undefined, null, 0, 1023, 65537, 4096.5, "8192"])("rejects invalid MCP output allowance %s", (mcpAutoDiscoveryMaxOutputTokens) => {
    expect(decodeAdminModelPolicyResponse({ modelPolicy: { candidates: [], policy: {
      defaultModel: null, reasoningEffort: null, mcpAutoDiscoveryTimeoutSeconds: 60,
      mcpAutoDiscoveryMaxOutputTokens, maxMcpToolsPerDiscovery: 10, maxToolCalls: 20, maxToolRounds: 8,
      updatedAt: "2026-09-09T00:00:00.000Z", updatedBy: null, version: 1
    } } })).toBeNull();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid tool budget %s",
    (maxToolCalls) => {
      expect(decodeAdminModelPolicyResponse({
        modelPolicy: {
          candidates: [],
          policy: {
            defaultModel: null,
            reasoningEffort: null,
            mcpAutoDiscoveryTimeoutSeconds: 60, mcpAutoDiscoveryMaxOutputTokens: 8192,
            maxMcpToolsPerDiscovery: 10,
            maxToolCalls,
            maxToolRounds: 8,
            updatedAt: "2026-08-17T00:00:00.000Z",
            updatedBy: null,
            version: 1
          }
        }
      })).toBeNull();
    }
  );
});
