import { describe, expect, it } from "vitest";
import {
  decodeCancelModelRunResponse,
  decodeRunOutcomeResponse,
  canRetryMcpAutoDiscoveryFailure,
  mcpAutoDiscoveryFailure,
  mcpAutoDiscoveryFailureForMessage
} from "./runs";

describe("safe MCP routing failures", () => {
  it.each(["mcp_router_gemini_invalid_request", "mcp_router_gemini_parameter_unknown", "mcp_router_request_rejected"])(
    "retains the fixed request rejection and recovery policy on reload: %s", (reason) => {
      const failure = mcpAutoDiscoveryFailure(reason);
      expect(failure.code).toBe("mcp_auto_discovery_request_rejected");
      expect(failure.message).toContain("System Model");
      expect(failure.message).toContain("Gemini HTTP 400");
      expect(failure.message).toContain("Load all to bypass automatic selection");
      expect(mcpAutoDiscoveryFailureForMessage(failure.message)).toEqual(failure);
      expect(canRetryMcpAutoDiscoveryFailure(failure.code)).toBe(false);
      expect(mcpAutoDiscoveryFailureForMessage(`${failure.message} PRIVATE_BODY`)).toBeNull();
    }
  );

  it("keeps transient System Model errors distinct from MCP materialization without retaining unknown data", () => {
    const transient = mcpAutoDiscoveryFailure("mcp_router_request_failed");
    const materialization = mcpAutoDiscoveryFailure("mcp_materialization_mcp_not_ready");
    expect(transient.message).toContain("System Model");
    expect(canRetryMcpAutoDiscoveryFailure(transient.code)).toBe(true);
    expect(materialization.message).toContain("activate the selected MCP tools");
    expect(materialization.code).not.toEqual(transient.code);
    expect(JSON.stringify(mcpAutoDiscoveryFailure("PRIVATE_PROVIDER_CODE"))).not.toContain("PRIVATE");
  });
});

describe("decodeCancelModelRunResponse", () => {
  it("decodes only the cancellation facts consumed by the browser", () => {
    expect(decodeCancelModelRunResponse({
      run: {
        id: "run-1",
        providerCancelPreview: { secret: "not-a-client-field" },
        providerResponseId: "provider-private",
        status: "cancelled"
      }
    })).toEqual({
      kind: "cancelled",
      run: { id: "run-1", status: "cancelled" }
    });

    expect(decodeCancelModelRunResponse({
      error: "model_run_not_cancelable",
      run: { id: "run-1", status: "complete" }
    })).toEqual({
      kind: "not_cancelled",
      run: { id: "run-1", status: "complete" }
    });
  });

  it.each([
    null,
    {},
    { run: null },
    { run: { id: "", status: "cancelled" } },
    { run: { id: "run-1", status: "preparing" } },
    { run: { id: "run-1", status: "complete" } },
    {
      error: "unexpected",
      run: { id: "run-1", status: "complete" }
    }
  ])("rejects malformed cancellation response %#", (value) => {
    expect(decodeCancelModelRunResponse(value)).toBeNull();
  });
});

describe("decodeRunOutcomeResponse", () => {
  it("decodes the versioned minimal outcome and ignores non-contract input fields", () => {
    expect(decodeRunOutcomeResponse({
      run: {
        events: [{ payload: "forbidden" }],
        id: "run-1",
        normalizedRequest: { prompt: "forbidden" },
        status: "complete"
      },
      version: 1
    })).toEqual({ id: "run-1", status: "complete" });
  });

  it.each([
    null,
    {},
    { run: { id: "run-1", status: "complete" } },
    { run: { id: "run-1", status: "complete" }, version: 2 },
    { run: null, version: 1 },
    { run: { id: "", status: "complete" }, version: 1 },
    { run: { id: "run-1", status: "preparing" }, version: 1 },
    { run: { id: "run-1", status: null }, version: 1 }
  ])("rejects malformed run outcome %#", (value) => {
    expect(decodeRunOutcomeResponse(value)).toBeNull();
  });
});
