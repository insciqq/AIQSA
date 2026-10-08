import { describe, expect, it } from "vitest";
import { createFakeProviderAdapter } from "./fakeProvider";
import type { ProviderRunRequest, ProviderRunResult } from "./types";

const deleteRecord = { capability: "mcp", description: "Delete one record", inputSchema: { type: "object" },
  name: "mcp_records_delete_record_0123456789" };
const continuation = "The user approved `delete_record` on `Records`. Continue the task.";

function request(text: string, providerToolMessages: unknown[] = [], history: string[] = []): ProviderRunRequest {
  const content = { blocks: [{ text, type: "text" }] };
  return { content, providerToolMessages, searchPlan: { mode: "all_selected", options: [] }, tools: [deleteRecord],
    ...(history.length ? { context: { messages: [...history.map((entry, index) => ({ content: { blocks: [{ text: entry, type: "text" }] },
      id: `history-${index}`, role: index % 2 === 0 ? "user" : "assistant" })), { content, id: "current", role: "user" }] } } : {})
  } as unknown as ProviderRunRequest;
}

async function run(input: ProviderRunRequest): Promise<ProviderRunResult> {
  const stream = createFakeProviderAdapter().stream(input);
  let next = await stream.next();
  while (!next.done) next = await stream.next();
  return next.value;
}

describe("fake provider MCP scenario", () => {
  it("calls the run's MCP tool once, then names the server's outcome", async () => {
    const asked = await run(request("Remove it [AIQSA_MCP_E2E:delete_record:r-1]"));
    expect(asked.toolCalls).toEqual([{ arguments: { id: "r-1" }, id: "fake-mcp-delete_record-r-1", name: deleteRecord.name }]);
    const refused = { content: [{ type: "json", value: { error: "mcp_approval_required" } }], status: "error", type: "fake_tool_result" };
    expect((await run(request("Remove it [AIQSA_MCP_E2E:delete_record:r-1]", [refused]))).finalText)
      .toBe("MCP call finished: mcp_approval_required.");
    const done = { content: [{ type: "text", text: "deleted" }], status: "complete", type: "fake_tool_result" };
    expect((await run(request("Remove it [AIQSA_MCP_E2E:delete_record:r-1]", [done]))).finalText).toBe("MCP call finished: done.");
  });

  it("repeats the newest asked call after the server's continuation turn, and nothing without the tool", async () => {
    const history = ["Remove it [AIQSA_MCP_E2E:delete_record:r-1]", "MCP call finished: mcp_approval_required.",
      "Remove another [AIQSA_MCP_E2E:delete_record:r-2]", "MCP call finished: mcp_approval_required."];
    expect((await run(request(continuation, [], history))).toolCalls?.[0]?.arguments).toEqual({ id: "r-2" });
    // Any other question never borrows a directive from the history.
    expect((await run(request("Thanks", [], history))).toolCalls ?? []).toEqual([]);
    const plain = await run({ ...request("Remove it [AIQSA_MCP_E2E:delete_record:r-1]"), tools: [] });
    expect(plain.toolCalls ?? []).toEqual([]);
  });

  it("makes the call from Workspace guest code and reports the gateway's outcome", async () => {
    const shell = { capability: "workspace", description: "Run a shell command", inputSchema: { type: "object" },
      name: "mcp_workspace_sandbox_shell_0123456789" };
    const inWorkspace = (text: string, results: unknown[] = [], history: string[] = []) =>
      ({ ...request(text, results, history), tools: [deleteRecord, shell], workspace: { outputDirectory: "/workspace/output" } }) as
        unknown as ProviderRunRequest;
    const asked = await run(inWorkspace("Remove it in code [AIQSA_MCP_CODE_E2E:delete_record:r-1]"));
    expect(asked.toolCalls).toHaveLength(1);
    expect(asked.toolCalls?.[0]?.name).toBe(shell.name);
    expect(String(asked.toolCalls?.[0]?.arguments.command)).toContain("aiqsa.mcp.call(name, {\"id\": \"r-1\"})");
    const refused = { content: [{ type: "text", text: JSON.stringify({ data: { exitCode: 0, stdout: "code-mcp:approval_required\n" } }) }],
      status: "complete", type: "fake_tool_result" };
    expect((await run(inWorkspace("Remove it in code [AIQSA_MCP_CODE_E2E:delete_record:r-1]", [refused]))).finalText)
      .toBe("Code MCP call finished: approval_required.");
    expect((await run(inWorkspace(continuation, [], ["Remove it in code [AIQSA_MCP_CODE_E2E:delete_record:r-1]",
      "Code MCP call finished: approval_required."]))).toolCalls?.[0]?.name).toBe(shell.name);
    // Without a Workspace the guest-code scenario never runs.
    expect((await run(request("Remove it in code [AIQSA_MCP_CODE_E2E:delete_record:r-1]"))).toolCalls ?? []).toEqual([]);
  });
});
