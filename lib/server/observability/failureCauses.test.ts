import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import constraints from "./databaseConstraints.json";
import { describeFailureFacts, retainFailureCause } from "./failureFacts.cjs";
import { serializeEvent } from "./runtime.cjs";
import { WORKSPACE_FAILURE_CAUSES } from "../workspace/toolObservability";
import { workspaceMcpFailure } from "../workspace/operationFailure";
import { workspaceFailureCause } from "../workspace/toolObservability";

const CANARY = "PRIVATE_DATA";
const unique = (meta: Record<string, unknown>) => new Prisma.PrismaClientKnownRequestError(CANARY,
  { clientVersion: "test", code: "P2002", meta });
const event = (name: Parameters<typeof serializeEvent>[0], fields: Record<string, unknown>) =>
  JSON.parse(serializeEvent(name, fields as never)!) as Record<string, unknown>;

describe("failure cause allowlists", () => {
  it("keeps schema-owned unique constraint names and maps Prisma field targets without retaining values", () => {
    for (const name of Object.keys(constraints)) {
      expect(describeFailureFacts(unique({ target: name })).db_constraint).toBe(name);
    }
    const fields = ["userId", "chatId", "branchGeneration", "sourceRevisionAtCreation", "projectionVersion", "sourceProjectionVersion", "roundOrdinal"];
    const failure = unique({ modelName: "MemoryRecallRound", target: fields, private: CANARY });
    expect(describeFailureFacts(failure)).toMatchObject({ prisma_code: "P2002", db_constraint: "MemoryRecallRound_source_ordinal_key" });
    expect(describeFailureFacts(unique({ modelName: "ModelRun", target: ["chatId", "subagentThreadId"] })).db_constraint)
      .toBe("ModelRun_one_active_per_chat_idx");
    const wrapped = new Error("wrapper");
    retainFailureCause(wrapped, failure);
    const record = event("job_persistence", { error: wrapped, job_kind: "INDEX_HISTORY", subsystem: "memory", stage: "complete", outcome: "unconfirmed" });
    expect(record).toMatchObject({ db_constraint: "MemoryRecallRound_source_ordinal_key", job_kind: "INDEX_HISTORY", prisma_code: "P2002" });
    expect(JSON.stringify(record)).not.toContain(CANARY);
    expect(describeFailureFacts(unique({ target: CANARY })).db_constraint).toBe("other");
    expect(describeFailureFacts(unique({ modelName: CANARY, target: [CANARY] })).db_constraint).toBe("other");
    expect(event("job_attempt", { subsystem: "memory", stage: "process", outcome: "failed", job_kind: CANARY })).not.toHaveProperty("job_kind");
  });

  it("allows only opaque MCP server and tool identities, registered fetch reasons and HTTP status classes", () => {
    const fields = { tool_kind: "mcp", stage: "execution", outcome: "failed", mcp_server: "a".repeat(32) };
    expect(event("tool_execution", fields).mcp_server).toBe("a".repeat(32));
    expect(event("tool_execution", { ...fields, mcp_server: CANARY })).not.toHaveProperty("mcp_server");
    expect(event("tool_call", { tool_kind: "fetch_url", outcome: "failed", fetch_reason: "fetch_http_status", httpStatus: 403,
      http_status_class: "4xx", tool_identity: "fetch_url" })).toMatchObject({ fetch_reason: "fetch_http_status", httpStatus: 403, http_status_class: "4xx", tool_identity: "fetch_url" });
    for (const key of ["fetch_reason", "http_status_class", "tool_identity"]) {
      expect(event("tool_call", { tool_kind: "fetch_url", outcome: "failed", [key]: CANARY })).not.toHaveProperty(key);
    }
    expect(event("tool_call", { tool_kind: "mcp", outcome: "failed", tool_identity: `mcp_${"b".repeat(32)}` }))
      .toHaveProperty("tool_identity", `mcp_${"b".repeat(32)}`);
  });

  it("counts a Workspace admission conflict by its registered reason", () => {
    expect(event("run_http_failed", { stage: "send", code: "workspace_busy", cause: "workspace_busy_live_export", httpStatus: 409 }))
      .toMatchObject({ code: "workspace_busy", cause: "workspace_busy_live_export", httpStatus: 409 });
    expect(event("run_http_failed", { stage: "send", code: "workspace_busy", cause: CANARY }).cause).toBe("unknown");
  });

  it("records the failed guest operation category without inferring errno from exception text", () => {
    const cause = (tool: "sandbox_fs_read" | "sandbox_exec", message: string) => workspaceFailureCause(workspaceMcpFailure({ isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: { code: "operation_failed", message } }) }] }, 4096, tool));
    expect(cause("sandbox_fs_read", `${CANARY} (os error 2)`)).toBe("guest_filesystem_failed");
    expect(cause("sandbox_fs_read", `${CANARY} EACCES`)).toBe("guest_filesystem_failed");
    expect(cause("sandbox_exec", CANARY)).toBe("guest_process_failed");
    for (const reason of WORKSPACE_FAILURE_CAUSES) {
      expect(event("tool_execution", { tool_kind: "workspace", stage: "execution", outcome: "failed", reason })).toHaveProperty("reason", reason);
    }
    expect(event("tool_execution", { tool_kind: "workspace", stage: "execution", outcome: "failed", reason: CANARY })).not.toHaveProperty("reason");
  });
});
