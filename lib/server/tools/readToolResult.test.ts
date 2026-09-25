import { describe, expect, it } from "vitest";
import { ObservationStoreError } from "../toolObservations/contract";
import { executeReadToolResult, READ_TOOL_RESULT_NAME } from "./readToolResult";

const call = { id: "reader-call", name: READ_TOOL_RESULT_NAME, arguments: { handle: `tor1_${"a".repeat(32)}` } };
const context = { runId: "run", userId: "user" };

describe("saved tool result reader failures", () => {
  it("reports a busy store as a transient read retry, never as an uncertain operation", async () => {
    const result = await executeReadToolResult({ read: async () => { throw new ObservationStoreError("tool_observation_busy"); } },
      call, context);
    expect(result.status).toBe("error");
    const [part] = result.content;
    const value = part?.type === "json" ? part.value as Record<string, unknown> : {};
    expect(value.code).toBe("tool_observation_busy");
    expect(value.message).toMatch(/temporarily busy/iu);
    expect(value.message).toMatch(/retry the same read/iu);
    expect(value.message).not.toMatch(/budget|exhausted|may have completed|execut/iu);
  });

  it("keeps the no-replay message for an unavailable saved result", async () => {
    const result = await executeReadToolResult({ read: async () => { throw new ObservationStoreError("tool_observation_unavailable"); } },
      call, context);
    const [part] = result.content;
    const value = part?.type === "json" ? part.value as Record<string, unknown> : {};
    expect(value).toMatchObject({ code: "tool_observation_unavailable" });
    expect(value.message).toMatch(/does not mean the original operation failed/iu);
  });
});
