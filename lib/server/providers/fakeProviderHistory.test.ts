import { describe, expect, it } from "vitest";
import { createFakeProviderAdapter } from "./fakeProvider";
import type { ProviderHistoryItem } from "./history";
import type { ProviderRunRequest, ProviderRunResult } from "./types";

const deleteRecord = { capability: "mcp", description: "Delete one record", inputSchema: { type: "object" },
  name: "mcp_records_delete_record_0123456789" };

/** A native engine request: the conversation is the neutral history, the content is not read. */
function request(history: readonly ProviderHistoryItem[]): ProviderRunRequest {
  return { content: { blocks: [] }, history, searchPlan: { mode: "all_selected", options: [] }, tools: [deleteRecord] } as unknown as
    ProviderRunRequest;
}

async function run(input: ProviderRunRequest): Promise<ProviderRunResult> {
  const stream = createFakeProviderAdapter().stream(input);
  let next = await stream.next();
  while (!next.done) next = await stream.next();
  return next.value;
}

describe("fake provider on the native engine's history", () => {
  it("answers the current input of the history", async () => {
    const result = await run(request([{ text: "Old question", type: "user" }, { text: "Old answer", type: "assistant_text" },
      { currentInput: true, text: "Hello QSA", type: "user" }]));
    expect(result.finalText).toBe("Fake answer: Hello QSA");
  });

  it("calls the MCP tool once and reads its result from the current turn, an approval continuation included", async () => {
    const asked = [{ currentInput: true as const, text: "Remove it [AIQSA_MCP_E2E:delete_record:r-1]", type: "user" as const }];
    expect((await run(request(asked))).toolCalls?.[0]).toMatchObject({ arguments: { id: "r-1" }, name: deleteRecord.name });
    // The continuation adds no user turn: the approved call's result follows the stopped turn.
    const continued = await run(request([{ text: asked[0].text, type: "user" },
      { arguments: "{\"id\":\"r-1\"}", callId: "fake-mcp-delete_record-r-1", name: deleteRecord.name, type: "tool_call" },
      { callId: "fake-mcp-delete_record-r-1", name: deleteRecord.name, output: "deleted", type: "tool_result" }]));
    expect(continued.finalText).toBe("MCP call finished: done.");
    // The engine sends the run context last in a continuation; it is no user turn.
    const withContext = await run(request([{ text: asked[0].text, type: "user" },
      { arguments: "{\"id\":\"r-1\"}", callId: "fake-mcp-delete_record-r-1", name: deleteRecord.name, type: "tool_call" },
      { callId: "fake-mcp-delete_record-r-1", name: deleteRecord.name, output: "deleted", type: "tool_result" },
      { text: "<turn_context>\nCurrent local time: Monday.\n</turn_context>", type: "user" }]));
    expect(withContext.finalText).toBe("MCP call finished: done.");
    const refused = await run(request([...asked,
      { arguments: "{}", callId: "c1", name: deleteRecord.name, type: "tool_call" },
      { callId: "c1", isError: true, name: deleteRecord.name, output: "{\"error\":\"mcp_approval_required\"}", type: "tool_result" }]));
    expect(refused.finalText).toBe("MCP call finished: mcp_approval_required.");
  });

  it("reads a Workspace tool's data from the history's JSON result", async () => {
    const tools = ["sandbox_fs_read", "sandbox_fs_write"].map((name) => ({ capability: "workspace", description: name,
      inputSchema: { type: "object" }, name: `workspace_${name}_0123456789` }));
    const workspaceRequest = (history: readonly ProviderHistoryItem[]) => ({ ...request(history), tools,
      workspace: { inboxIndexPath: "/workspace/inbox/index.json", outputDirectory: "/workspace/outputs" } }) as unknown as
      ProviderRunRequest;
    const asked = { currentInput: true as const, text: "[AIQSA_WORKSPACE_E2E:deterministic_prepare]", type: "user" as const };
    const index = { attachments: [{ attachmentId: "a-1", sandboxPath: "/workspace/inbox/m-1/a-1/input.bin" }] };
    const result = await run(workspaceRequest([asked,
      { arguments: "{}", callId: "c1", name: tools[0]!.name, type: "tool_call" },
      { callId: "c1", name: tools[0]!.name, output: JSON.stringify({ data: { content: JSON.stringify(index) } }), type: "tool_result" }]));
    expect(result.toolCalls?.[0]).toMatchObject({ arguments: { encoding: "base64", path: "/workspace/inbox/m-1/a-1/input.bin" },
      name: tools[0]!.name });
  });
});
