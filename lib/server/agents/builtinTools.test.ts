import { describe, expect, it, vi } from "vitest";
import type { NormalizedRunRequest } from "../providers/types";
import type { ToolExecutionResult } from "../tools/types";
import type { createAgentRunStore } from "./store";
import { agentBuiltinTools, createAgentBuiltinDispatcher } from "./builtinTools";
import { WorkspaceCheckpointError } from "../workspace/checkpointInput";

const request = { workspace: {}, agent: { mcpMode: "off", imageInput: false },
  visionAnalysis: { version: 1, available: false, code: "vision_model_absent" } } as unknown as NormalizedRunRequest;
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
