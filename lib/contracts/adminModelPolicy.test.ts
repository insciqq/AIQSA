import { describe, expect, it } from "vitest";
import { decodeAdminModelPolicyResponse } from "./adminModelPolicy";

describe("administrator model policy contract", () => {
  it("accepts only the model-agnostic observation rollout modes", () => {
    const base = {
      modelPolicy: {
        candidates: [],
        policy: {
          defaultModel: null,
          reasoningEffort: null,
          maxMcpToolsPerDiscovery: 10,
          toolLimitsEnabled: false,
          maxToolCalls: 20,
          maxToolRounds: 8,
          toolObservationPolicy: "off",
          updatedAt: "2026-09-24T00:00:00.000Z",
          updatedBy: null,
          version: 1
        }
      }
    };
    expect(decodeAdminModelPolicyResponse(base)?.modelPolicy.policy.toolObservationPolicy).toBe("off");
    expect(decodeAdminModelPolicyResponse({
      modelPolicy: { ...base.modelPolicy, policy: { ...base.modelPolicy.policy, toolObservationPolicy: "v1" } }
    })?.modelPolicy.policy.toolObservationPolicy).toBe("v1");
    expect(decodeAdminModelPolicyResponse({
      modelPolicy: { ...base.modelPolicy, policy: { ...base.modelPolicy.policy, toolObservationPolicy: "codex-lb" } }
    })).toBeNull();
  });

  it("decodes the MCP Auto tool count and never projects the retired discovery settings", () => {
    const policy = decodeAdminModelPolicyResponse({
      modelPolicy: {
        candidates: [],
        policy: {
          defaultModel: null,
          reasoningEffort: null,
          mcpAutoDiscoveryTimeoutSeconds: 60, mcpAutoDiscoveryMaxOutputTokens: 8192,
          maxMcpToolsPerDiscovery: 10,
          toolLimitsEnabled: true,
          maxToolCalls: 200,
          maxToolRounds: 200,
          updatedAt: "2026-08-17T00:00:00.000Z",
          updatedBy: null,
          version: 1
        }
      }
    })?.modelPolicy.policy;
    expect(policy).toMatchObject({ maxMcpToolsPerDiscovery: 10, maxToolCalls: 200, maxToolRounds: 200, toolLimitsEnabled: true });
    expect(policy).not.toHaveProperty("mcpAutoDiscoveryTimeoutSeconds");
    expect(policy).not.toHaveProperty("mcpAutoDiscoveryMaxOutputTokens");
  });

  it.each([undefined, 0, 129, 4.5, "10"])("rejects an invalid MCP Auto tool count %s", (maxMcpToolsPerDiscovery) => {
    expect(decodeAdminModelPolicyResponse({ modelPolicy: { candidates: [], policy: {
      defaultModel: null, reasoningEffort: null, maxMcpToolsPerDiscovery, toolLimitsEnabled: false, maxToolCalls: 20, maxToolRounds: 8,
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
            maxMcpToolsPerDiscovery: 10,
            toolLimitsEnabled: true,
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

  it("decodes the tool limits switch and refuses a response without it", () => {
    const policy = (toolLimitsEnabled: unknown) => ({ modelPolicy: { candidates: [], policy: {
      defaultModel: null, reasoningEffort: null, maxMcpToolsPerDiscovery: 10, maxToolCalls: 80, maxToolRounds: 32,
      ...(toolLimitsEnabled === undefined ? {} : { toolLimitsEnabled }),
      updatedAt: "2026-10-26T00:00:00.000Z", updatedBy: null, version: 1
    } } });
    // Off, the saved numbers are still the ones turning the limits on would apply.
    expect(decodeAdminModelPolicyResponse(policy(false))?.modelPolicy.policy)
      .toMatchObject({ maxToolCalls: 80, maxToolRounds: 32, toolLimitsEnabled: false });
    expect(decodeAdminModelPolicyResponse(policy(true))?.modelPolicy.policy.toolLimitsEnabled).toBe(true);
    for (const value of [undefined, null, "false", 0]) expect(decodeAdminModelPolicyResponse(policy(value))).toBeNull();
  });
});
