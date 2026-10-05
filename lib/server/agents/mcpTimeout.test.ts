import { describe, expect, it } from "vitest";
import type { NormalizedRunRequest } from "../providers/types";
import { agentMcpEnvelopeTimeoutSeconds } from "./mcpTimeout";
import { renderCodexManagedProfile } from "./codexProfile";
import { syntheticImagePlan } from "@/tests/support/imagePlan";
import type { AvailableVisionAnalysisPlan } from "../providerRuntime/visionAnalysis";

describe("Agent MCP envelope", () => {
  it("accommodates the accepted image deadline and durable upload without extending the run deadline", () => {
    const request = { searchPlan: { options: [] }, imagePlan: syntheticImagePlan() } as unknown as NormalizedRunRequest;
    expect(agentMcpEnvelopeTimeoutSeconds(request)).toBe(390);
  });
  it("allows an admitted slow tool and startup to finish independently of discovery", () => {
    const request = { searchPlan: { options: [] }, mcp: { servers: [{ runtimeTimeouts: { startupTimeoutMs: 60000, callTimeoutMs: 7200000 } }] }
    } as unknown as NormalizedRunRequest;
    const seconds = agentMcpEnvelopeTimeoutSeconds(request);
    expect(seconds).toBe(7290);
    expect(renderCodexManagedProfile({ contextWindowTokens: 128000, developerInstructions: "Fixture",
      gatewayOrigin: "http://agent-gateway:4311", maxOutputTokens: 16000, mcpMode: "auto",
      mcpTimeoutSeconds: seconds, modelId: "fixture" })).toContain("tool_timeout_sec = 7290");
  });
  it("gives discovery a fixed allowance plus server startup instead of a model deadline", () => {
    const request = { searchPlan: { options: [] },
      mcpDiscovery: { catalog: { servers: [{ runtimeTimeouts: { startupTimeoutMs: 60000, callTimeoutMs: 1000 } }] } }
    } as unknown as NormalizedRunRequest;
    expect(agentMcpEnvelopeTimeoutSeconds(request)).toBe(120);
  });
  it("lets a Workspace analyze_image run to its reasoning-effort deadline", () => {
    const visionAnalysis = { version: 1, available: true, reasoningEffort: "high",
      snapshot: { model: { defaultParams: {}, capabilities: {} } } } as unknown as AvailableVisionAnalysisPlan;
    const base = { searchPlan: { options: [] }, workspace: {} };
    expect(agentMcpEnvelopeTimeoutSeconds({ ...base, visionAnalysis } as unknown as NormalizedRunRequest)).toBe(210);
    expect(agentMcpEnvelopeTimeoutSeconds({ ...base, visionAnalysis: { ...visionAnalysis, reasoningEffort: "low" } } as unknown as NormalizedRunRequest)).toBe(90);
    // No admitted analysis keeps the discovery allowance.
    expect(agentMcpEnvelopeTimeoutSeconds({ ...base, visionAnalysis: { version: 1, available: false, code: "vision_model_absent" } } as unknown as NormalizedRunRequest)).toBe(60);
    expect(agentMcpEnvelopeTimeoutSeconds({ searchPlan: { options: [] }, visionAnalysis } as unknown as NormalizedRunRequest)).toBe(60);
  });
});
