import { describe, expect, it } from "vitest";
import {
  memoryExecutionOwnerData,
  memoryExecutionOwnerWhere,
  storedMemoryExecutionOwner
} from "./owner";

const emptyStoredFields = {
  memoryJobId: null,
  modelRunId: null,
  modelRunToolCallId: null,
  mutationAuthorizationId: null,
  retrievalAttemptId: null
} as const;

describe("Memory execution owner", () => {
  it("round-trips a content-free inbound MCP request owner", () => {
    const owner = {
      inboundMcpRequestId: "request-1",
      type: "INBOUND_MCP_REQUEST" as const
    };
    const stored = memoryExecutionOwnerData(owner);

    expect(stored).toEqual({
      ...emptyStoredFields,
      inboundMcpRequestId: "request-1",
      ownerType: "INBOUND_MCP_REQUEST"
    });
    expect(storedMemoryExecutionOwner(stored)).toEqual(owner);
    expect(memoryExecutionOwnerWhere("user-1", owner)).toEqual({
      ...stored,
      userId: "user-1"
    });
  });

  it("rejects malformed or mixed inbound MCP ownership", () => {
    expect(() => memoryExecutionOwnerData({
      inboundMcpRequestId: "bad\nrequest",
      type: "INBOUND_MCP_REQUEST"
    })).toThrow("memory_execution_input_invalid");
    expect(() => storedMemoryExecutionOwner({
      ...emptyStoredFields,
      inboundMcpRequestId: "request-1",
      memoryJobId: "job-1",
      ownerType: "INBOUND_MCP_REQUEST"
    })).toThrow("memory_execution_snapshot_invalid");
  });
});
