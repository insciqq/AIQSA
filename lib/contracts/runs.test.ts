import { describe, expect, it } from "vitest";
import {
  decodeCancelModelRunResponse,
  decodeRunOutcomeResponse,
  isMcpAutoDiscoveryFailureCode,
  MCP_AUTO_DISCOVERY_UNAVAILABLE_CODE,
  MCP_AUTO_DISCOVERY_UNAVAILABLE_MESSAGE,
  mcpAutoDiscoveryFailure,
  mcpAutoDiscoveryFailureForMessage
} from "./runs";

describe("safe MCP Auto discovery failures", () => {
  it("keeps the materialization cause and maps everything else to the generic failure", () => {
    const materialization = mcpAutoDiscoveryFailure("mcp_materialization_mcp_not_ready");
    expect(materialization).toEqual(mcpAutoDiscoveryFailure("mcp_materialization_failed"));
    expect(materialization.message).toContain("activate the selected MCP tools");
    expect(materialization.message).toContain("Load all");
    expect(mcpAutoDiscoveryFailureForMessage(materialization.message)).toEqual(materialization);
    expect(mcpAutoDiscoveryFailure("mcp_discovery_limit_invalid")).toEqual({
      code: MCP_AUTO_DISCOVERY_UNAVAILABLE_CODE, message: MCP_AUTO_DISCOVERY_UNAVAILABLE_MESSAGE });
    expect(JSON.stringify(mcpAutoDiscoveryFailure("PRIVATE_PROVIDER_CODE"))).not.toContain("PRIVATE");
    expect(mcpAutoDiscoveryFailureForMessage(`${materialization.message} PRIVATE_BODY`)).toBeNull();
    expect(mcpAutoDiscoveryFailureForMessage(null)).toBeNull();
  });

  it("renders stored codes and copy of the retired System Model selector as the generic failure", () => {
    for (const code of ["mcp_auto_discovery_request_rejected", "mcp_auto_discovery_timeout", "mcp_auto_discovery_model_unavailable"]) {
      expect(isMcpAutoDiscoveryFailureCode(code)).toBe(true);
    }
    expect(isMcpAutoDiscoveryFailureCode("mcp_auto_discovery_unknown_future")).toBe(false);
    for (const stored of [
      "The System Model rejected automatic tool selection (Gemini HTTP 400: invalid_request). Ask an administrator to check its routing compatibility, or use Load all to bypass automatic selection.",
      "Automatic tool discovery exceeded its time limit. Retry in Auto or use Load all."
    ]) {
      expect(mcpAutoDiscoveryFailureForMessage(stored)).toEqual({
        code: MCP_AUTO_DISCOVERY_UNAVAILABLE_CODE, message: MCP_AUTO_DISCOVERY_UNAVAILABLE_MESSAGE });
    }
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
  it("keeps published answers and waiting successors as separate safe facts", () => {
    expect(decodeRunOutcomeResponse({ version: 1, run: { id: "previous", status: "streaming", answerComplete: true,
      answerCompletionUsage: { private: "omitted" } } })).toEqual({ id: "previous", status: "streaming", answerComplete: true });
    expect(decodeRunOutcomeResponse({ version: 1, run: { id: "next", status: "queued", workspacePreparation: true,
      snapshot: { private: "omitted" } } })).toEqual({ id: "next", status: "queued", workspacePreparation: true });
    for (const run of [
      { id: "run", status: "streaming", workspacePreparation: true },
      { id: "run", status: "queued", workspacePreparation: true, answerComplete: true },
      { id: "run", status: "streaming", answerComplete: "true" }
    ]) expect(decodeRunOutcomeResponse({ version: 1, run })).toBeNull();
  });
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
