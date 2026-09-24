import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_POLICY, decodeAgentPolicy } from "@/lib/contracts/agentPolicy";
import { agentLimits, validNormalizedAgent } from "./config";

const env = { AIQSA_AGENT_GATEWAY_URL: "http://agent.invalid", AIQSA_AGENT_MAX_MODEL_CALLS: "1" };
describe("Agent installation policy snapshots", () => {
  it("validates the frozen image capability independently of declared model hints", () => {
    const config = { ...agentLimits(DEFAULT_AGENT_POLICY, env), compatibilityHash: "a".repeat(64), mcpMode: "off" };
    expect(validNormalizedAgent({ ...config, imageInput: false })).toBe(true);
    expect(validNormalizedAgent({ ...config, imageInput: true })).toBe(true);
    expect(validNormalizedAgent({ ...config, imageInput: "true" })).toBe(false);
    expect(validNormalizedAgent({ ...config, imageInput: true, other: true })).toBe(false);
  });
  it("starts with enforcement off and ignores former environment budgets", () => {
    const config = agentLimits(DEFAULT_AGENT_POLICY, env);
    expect(config).toMatchObject({ limitsEnabled: false, timeoutSeconds: null, maxModelCalls: 40, policyVersion: 1 });
    expect(validNormalizedAgent({ ...config, compatibilityHash: "a".repeat(64), mcpMode: "off" })).toBe(true);
  });
  it("freezes enabled settings without mutating the policy", () => {
    const policy = { ...DEFAULT_AGENT_POLICY, limitsEnabled: true, version: 3, maxModelCalls: 2 };
    const config = agentLimits(policy, env);
    policy.maxModelCalls = 1;
    expect(config).toMatchObject({ maxModelCalls: 2, timeoutSeconds: 3600, policyVersion: 3 });
    expect(validNormalizedAgent({ ...config, compatibilityHash: "a".repeat(64), mcpMode: "auto" })).toBe(true);
  });
  it("accepts a model output setting above the Agent policy range only when enforcement is off", () => {
    const config = { ...agentLimits(DEFAULT_AGENT_POLICY, env), compatibilityHash: "a".repeat(64),
      mcpMode: "off", maxOutputTokens: 262144 };
    expect(validNormalizedAgent(config)).toBe(true);
    expect(validNormalizedAgent({ ...config, limitsEnabled: true, timeoutSeconds: 3600 })).toBe(false);
    expect(validNormalizedAgent({ ...config, maxOutputTokens: 0 })).toBe(false);
  });
  it("rejects malformed saved policies and hidden deadlines in Off", () => {
    for (const patch of [{ limitsEnabled: "false" }, { maxModelCalls: 0 }, { timeoutSeconds: 7201 },
      { version: 0 }, { maxToolCalls: 1.5 }, { tokenBudget: NaN }, { extra: true }]) {
      expect(decodeAgentPolicy({ ...DEFAULT_AGENT_POLICY, ...patch })).toBeNull();
    }
    expect(validNormalizedAgent({ ...agentLimits(DEFAULT_AGENT_POLICY, env), compatibilityHash: "a".repeat(64),
      mcpMode: "off", timeoutSeconds: 3600 })).toBe(false);
  });
});
