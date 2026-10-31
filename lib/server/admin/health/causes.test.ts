import { describe, expect, it } from "vitest";
import type { TelemetryCounterGroup } from "../../telemetry/store";
import { healthFailureCauses } from "./causes";

const row = (group: TelemetryCounterGroup["group"], count = 10): TelemetryCounterGroup => ({
  group, count, lastSeenAt: new Date("2026-10-31T00:00:00Z")
} as unknown as TelemetryCounterGroup);

describe("aggregate failure causes", () => {
  it("names causes and scale without counting MCP or Workspace stages again", () => {
    const causes = healthFailureCauses([
      ...["request", "execution", "result"].map((stage) => row({ event: "tool_execution", tool_kind: "mcp", stage,
        outcome: "failed", tool_scope: "model_call", code: "mcp_tool_reported_error", mcp_server: "a".repeat(32) })),
      row({ event: "tool_call", tool_kind: "mcp", outcome: "failed", code: "mcp_tool_reported_error" }),
      row({ event: "tool_call", tool_kind: "fetch_url", outcome: "failed", fetch_reason: "fetch_http_status", httpStatus: 403, http_status_class: "4xx" }, 9),
      row({ event: "job_persistence", outcome: "unconfirmed", db_constraint: "MemoryRecallRound_source_ordinal_key", job_kind: "INDEX_HISTORY" }, 8),
      row({ event: "provider_operation", outcome: "failed", provider_error_code: "overloaded_error" }, 7),
      row({ event: "run_http_failed", code: "workspace_busy", cause: "workspace_busy_live_export", httpStatus: 409 }, 6)
    ]);
    expect(causes.rows.map(({ event, count }) => [event, count])).toEqual([
      ["tool_call", 10], ["tool_call", 9], ["job_persistence", 8], ["provider_operation", 7], ["run_http_failed", 6]
    ]);
    expect(causes.rows[2]?.facts).toEqual({ db_constraint: "MemoryRecallRound_source_ordinal_key", job_kind: "INDEX_HISTORY" });
    expect(causes.truncated).toBe(false);
  });
});
