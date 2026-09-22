import { describe, expect, it } from "vitest";
import type { NormalizedRunRequest } from "../providers/types";
import { agentMcpEnvelopeTimeoutSeconds } from "./mcpTimeout";
import { renderCodexManagedProfile } from "./codexProfile";
import { syntheticImagePlan } from "@/tests/support/imagePlan";

describe("Agent MCP envelope", () => {
  it("accommodates the accepted image deadline and durable upload without extending the run deadline", () => {
    const request = { searchPlan: { options: [] }, imagePlan: syntheticImagePlan() } as unknown as NormalizedRunRequest;
    expect(agentMcpEnvelopeTimeoutSeconds(request)).toBe(390);
  });
  it("allows an admitted slow tool and startup to finish independently of discovery", () => {
    const request = { searchPlan: { options: [] }, toolBudgets: { mcpAutoDiscoveryTimeoutSeconds: 300 },
      mcp: { servers: [{ runtimeTimeouts: { startupTimeoutMs: 60000, callTimeoutMs: 7200000 } }] }
    } as unknown as NormalizedRunRequest;
    const seconds = agentMcpEnvelopeTimeoutSeconds(request);
    expect(seconds).toBe(7290);
    expect(renderCodexManagedProfile({ contextWindowTokens: 128000, developerInstructions: "Fixture",
      gatewayOrigin: "http://agent-gateway:4311", maxOutputTokens: 16000, mcpMode: "auto",
      mcpTimeoutSeconds: seconds, modelId: "fixture" })).toContain("tool_timeout_sec = 7290");
  });
});
