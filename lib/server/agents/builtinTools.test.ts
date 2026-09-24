import { describe, expect, it, vi } from "vitest";
import type { NormalizedRunRequest } from "../providers/types";
import type { ToolExecutionResult } from "../tools/types";
import type { createAgentRunStore } from "./store";
import { agentBuiltinTools, createAgentBuiltinDispatcher } from "./builtinTools";
import { WorkspaceCheckpointError } from "../workspace/checkpointInput";
import { ObservationStoreError } from "../toolObservations/contract";

const request = { workspace: {}, agent: { mcpMode: "off", imageInput: false },
  visionAnalysis: { version: 1, available: false, code: "vision_model_absent" } } as unknown as NormalizedRunRequest;

describe("native saved-result reader", () => {
  it("reauthorizes repeated deliveries instead of returning a cached fragment after revocation or Stop", async () => {
    const accepted = { ...request, workspace: undefined, toolObservationVersion: 1 as const };
    expect(agentBuiltinTools(accepted).map(tool => tool.name)).toEqual(["read_tool_result"]);
    const observation = { version: 1 as const, source: "workspace" as const, handle: `tor1_${"a".repeat(32)}`,
      byteSize: 20, checksum: "b".repeat(64), sourceTruncated: false, maskable: true, encoding: "json-utf8-v1" as const };
    const call = { id: "read", name: "read_tool_result", arguments: { handle: observation.handle } };
    let allowed = true;
    const read = vi.fn(async () => {
      if (!allowed) throw new ObservationStoreError("tool_observation_unavailable");
      return { observation, fragmentKind: "serialized_json_text" as const, fragment: "synthetic accepted bytes",
        offset: 0, endOffset: 20, incomplete: false, matchOffset: null, cursor: null };
    });
    const store = { claimBuiltinTool: vi.fn(async () => ({ claimed: true, id: "tool", result: null as ToolExecutionResult | null })),
      settleBuiltinTool: vi.fn(async () => {}), builtinResult: vi.fn(async (): Promise<ToolExecutionResult | null> => null) };
    const dispatch = createAgentBuiltinDispatcher({ request: accepted, runId: "run", userId: "user",
      store: store as unknown as ReturnType<typeof createAgentRunStore>, observations: { read } });
    const original = await dispatch(call, new AbortController().signal);
    expect(original.status).toBe("complete");
    store.claimBuiltinTool.mockResolvedValue({ claimed: false, id: "tool", result: original });
    allowed = false;
    const revoked = await dispatch(call, new AbortController().signal);
    expect(revoked.status).toBe("error");
    expect(JSON.stringify(revoked)).not.toContain("synthetic accepted bytes");
    expect(read).toHaveBeenCalledTimes(2);
    const controller = new AbortController();
    read.mockImplementation(async () => { controller.abort(new Error("synthetic_stop")); throw controller.signal.reason; });
    store.builtinResult.mockResolvedValue(original);
    await expect(dispatch(call, controller.signal)).rejects.toThrow("synthetic_stop");
  });
});
describe("native first-party System Vision dispatch", () => {
  it("registers the precise capability even with external MCP Off and a text-only main model", () => {
    expect(agentBuiltinTools(request).map(tool => tool.name)).toEqual(["analyze_image"]);
    expect(agentBuiltinTools({ ...request, workspace: undefined })).toEqual([]);
  });
  it("settles no-dispatch capability failures and never retries an already claimed call", async () => {
    const call = { id: "call", name: "analyze_image", arguments: { images: [{ path: "project/a.png" }], question: "What?" } };
    const result: ToolExecutionResult = { callId: call.id, name: call.name, status: "error", content: [{ type: "json", value: { error: "vision_model_absent" } }] };
    const store = { claimBuiltinTool: vi.fn(async () => ({ claimed: true, id: "tool", result: null as ToolExecutionResult | null })),
      settleBuiltinTool: vi.fn(async () => {}), startBuiltinVision: vi.fn(), lockBuiltinSettlement: vi.fn(),
      assertActiveInTransaction: vi.fn(), settleBuiltinToolInTransaction: vi.fn() };
    const execute = vi.fn(async () => result);
    const dispatch = createAgentBuiltinDispatcher({ request, runId: "run", userId: "user", store: store as unknown as ReturnType<typeof createAgentRunStore>, vision: { execute } });
    expect(await dispatch(call, new AbortController().signal)).toEqual(result);
    expect(store.settleBuiltinTool).toHaveBeenCalledExactlyOnceWith("tool", result);
    store.claimBuiltinTool.mockResolvedValue({ claimed: false, id: "tool", result });
    expect(await dispatch(call, new AbortController().signal)).toEqual(result);
    expect(execute).toHaveBeenCalledOnce();
    store.claimBuiltinTool.mockResolvedValue({ claimed: false, id: "tool", result: null });
    expect(JSON.stringify(await dispatch(call, new AbortController().signal))).toContain("agent_builtin_in_progress");
    expect(execute).toHaveBeenCalledOnce();
  });
});


describe("native checkpoint publication", () => {
  it.each([true, false])("preserves typed unavailable failures on claimed=%s without a success receipt", async claimed => {
    const call = { id: "save", name: "checkpoint_outputs", arguments: { files: ["project/a.psd"], description: "Draft" } };
    const store = { claimBuiltinTool: vi.fn(async () => ({ claimed, id: "tool", result: null })),
      builtinResult: vi.fn(async () => null), settleBuiltinTool: vi.fn(async () => {}) };
    const fail = vi.fn(async (): Promise<ToolExecutionResult> => { throw new WorkspaceCheckpointError("workspace_checkpoint_unavailable"); });
    const dispatch = createAgentBuiltinDispatcher({ request: { ...request, workspaceCheckpoints: true }, runId: "run", userId: "user",
      store: store as unknown as ReturnType<typeof createAgentRunStore>, checkpoints: { execute: fail, restore: fail } });
    const result = await dispatch(call, new AbortController().signal);
    expect(result).toMatchObject({ status: "error", content: [{ value: { error: "workspace_checkpoint_unavailable" } }] });
    expect(result.artifacts).toBeUndefined();
    expect(store.settleBuiltinTool).toHaveBeenCalledTimes(claimed ? 1 : 0);
  });
  it("uses the shared consumer with MCP Off and restores a lost receipt without a second execution", async () => {
    const accepted = { ...request, workspaceCheckpoints: true as const };
    expect(agentBuiltinTools(accepted).some(tool => tool.name === "checkpoint_outputs")).toBe(true);
    const call = { id: "save", name: "checkpoint_outputs", arguments: { files: ["project/a.psd"], description: "Draft" } };
    const result: ToolExecutionResult = { callId: call.id, name: call.name, status: "complete", content: [{ type: "json", value: { status: "saved" } }] };
    const store = { claimBuiltinTool: vi.fn(async () => ({ claimed: true, id: "tool", result: null })), builtinResult: vi.fn() };
    const checkpoints = { execute: vi.fn(async () => result), restore: vi.fn(async () => result) };
    const dispatch = createAgentBuiltinDispatcher({ request: accepted, runId: "run", userId: "user",
      store: store as unknown as ReturnType<typeof createAgentRunStore>, checkpoints });
    await expect(dispatch(call, new AbortController().signal)).resolves.toEqual(result);
    store.claimBuiltinTool.mockResolvedValue({ claimed: false, id: "tool", result: null });
    await expect(dispatch(call, new AbortController().signal)).resolves.toEqual(result);
    expect(checkpoints.execute).toHaveBeenCalledOnce();
    expect(checkpoints.restore).toHaveBeenCalledOnce();
  });
});
