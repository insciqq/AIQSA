import { describe, expect, it } from "vitest";
import {
  decodeThreadToolActivity,
  mergeThreadToolActivity,
  projectThreadToolActivity
} from "./toolActivity";

function call(callId: string, ordinal: number, round = 1) {
  return {
    artifactType: "tool_call",
    payload: {
      argumentsPreview: { query: callId },
      callId,
      ordinal,
      round,
      snapshot: {
        capability: "mcp",
        credentialSources: ["personal"],
        externalAccountLabel: "Team workspace",
        serverName: "Tasks",
        toolName: "lookup"
      },
      status: "requested"
    }
  };
}

describe("tool activity projection", () => {
  it("correlates parallel call/result evidence and preserves provider order", () => {
    const projected = projectThreadToolActivity([
      call("call-b", 1),
      call("call-a", 0),
      {
        artifactType: "tool_result",
        payload: {
          callId: "call-a",
          durationMs: 85,
          ordinal: 0,
          resultPreview: { content: [{ text: "done", type: "text" }] },
          round: 1,
          status: "complete"
        }
      }
    ]);

    expect(projected).toMatchObject([
      {
        callId: "call-a",
        durationMs: 85,
        ordinal: 0,
        status: "complete"
      },
      {
        callId: "call-b",
        ordinal: 1,
        status: "running"
      }
    ]);
  });

  it("marks unresolved calls from terminal runs without inventing a result", () => {
    expect(projectThreadToolActivity([call("cancelled", 0)], "cancelled")[0]).toMatchObject({
      resultPreview: null,
      status: "cancelled"
    });
    expect(projectThreadToolActivity([call("orphaned", 0)], "error")[0]).toMatchObject({
      resultPreview: null,
      status: "error"
    });
  });

  it("fails closed for mismatched results and malformed wire entries", () => {
    const projected = projectThreadToolActivity([
      call("call-1", 0),
      {
        artifactType: "tool_result",
        payload: {
          callId: "call-1",
          ordinal: 9,
          resultPreview: { leaked: "wrong call" },
          round: 1,
          status: "complete"
        }
      }
    ]);
    expect(projected[0]?.status).toBe("running");
    expect(decodeThreadToolActivity({ ...projected[0], credentialSources: ["unknown"] })).toBeNull();
    expect(decodeThreadToolActivity({
      ...projected[0],
      argumentsPreview: "x".repeat(9_000)
    })).toBeNull();

    const malformedSearch = projectThreadToolActivity([
      call("call-search", 0),
      {
        artifactType: "tool_result",
        payload: {
          callId: "call-search",
          ordinal: 0,
          resultPreview: null,
          round: 1,
          searchExecutions: [{ providerOperations: "raw provider payload" }],
          status: "complete"
        }
      }
    ]);
    expect(malformedSearch[0]).toMatchObject({
      resultPreview: null,
      status: "running"
    });
    expect(malformedSearch[0]).not.toHaveProperty("searchExecutions");
  });

  it("keeps terminal live evidence when a durable snapshot is still running", () => {
    const running = projectThreadToolActivity([call("call-1", 0)])[0]!;
    const complete = projectThreadToolActivity([
      call("call-1", 0),
      {
        artifactType: "tool_result",
        payload: {
          callId: "call-1",
          durationMs: 75,
          ordinal: 0,
          resultPreview: { content: [{ text: "done", type: "text" }] },
          round: 1,
          status: "complete"
        }
      }
    ])[0]!;

    expect(mergeThreadToolActivity(complete, running)).toMatchObject({
      durationMs: 75,
      resultPreview: { content: [{ text: "done", type: "text" }] },
      status: "complete"
    });
  });
});
