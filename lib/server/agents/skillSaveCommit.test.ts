import { describe, expect, it, vi } from "vitest";
import type { NormalizedRunRequest } from "../providers/types";
import type { ToolExecutionResult } from "../tools/types";
import type { createAgentRunStore } from "./store";
import { agentBuiltinTools, createAgentBuiltinDispatcher } from "./builtinTools";

describe("Agent Skill save builtin", () => {
  it("is offered only with the frozen marker and saves through the claim without repeating a pending delivery", async () => {
    const accepted = { workspace: { outputDirectory: "/workspace/output/run" }, skillSaveTool: true as const,
      agent: { mcpMode: "off", imageInput: false } } as unknown as NormalizedRunRequest;
    expect(agentBuiltinTools(accepted).map(tool => tool.name)).toEqual(["save_skill"]);
    expect(agentBuiltinTools({ ...accepted, skillSaveTool: undefined }).map(tool => tool.name)).toEqual([]);
    const files: Record<string, Buffer> = {
      "project/s/SKILL.md": Buffer.from("---\nname: s\ndescription: d\n---\nBody\n"), "project/s/run.sh": Buffer.from("#!/bin/sh\necho\n")
    };
    const read = vi.fn(async (input: { files: readonly { root: string; relativePath: string }[] }) => input.files.map((file) => {
      const path = `${file.root}/${file.relativePath}`;
      return { relativePath: path, byteSize: files[path]!.length, bytes: files[path]! };
    }));
    const saved: ToolExecutionResult = { callId: "save", name: "save_skill", status: "complete", content: [{ type: "json", value: { saved: true } }] };
    const commit = vi.fn(async () => ({ kind: "saved" as const, result: saved }));
    const store = { claimBuiltinTool: vi.fn(async () => ({ claimed: true, id: "claim-1", result: null as ToolExecutionResult | null })),
      settleBuiltinTool: vi.fn(async (_id: string, _result: ToolExecutionResult) => {}),
      builtinResult: vi.fn(async (): Promise<ToolExecutionResult | null> => null) };
    const commitFor = vi.fn((_claimId: string) => commit);
    const dispatch = createAgentBuiltinDispatcher({ request: accepted, runId: "run", userId: "user",
      store: store as unknown as ReturnType<typeof createAgentRunStore>,
      skillSave: { reader: async () => ({ read, secrets: async () => [] }), commit: commitFor } });
    const call = { id: "save", name: "save_skill", arguments: { directory: "/workspace/project/s", files: ["SKILL.md", "run.sh"],
      target: "new", expectedVersion: null, changeNote: null } };
    expect(await dispatch(call, new AbortController().signal)).toBe(saved);
    expect(commitFor).toHaveBeenCalledWith("claim-1");
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ consumerKey: "claim-1", runId: "run", userId: "user" }));
    expect(store.settleBuiltinTool).toHaveBeenCalledWith("claim-1", saved);
    // A settled delivery replays its result; a pending one never saves again.
    store.claimBuiltinTool.mockResolvedValueOnce({ claimed: false, id: "claim-1", result: saved });
    expect(await dispatch(call, new AbortController().signal)).toBe(saved);
    store.claimBuiltinTool.mockResolvedValueOnce({ claimed: false, id: "claim-1", result: null });
    expect(await dispatch(call, new AbortController().signal)).toMatchObject({ status: "error",
      content: [{ value: { error: "agent_builtin_in_progress" } }] });
    expect(commit).toHaveBeenCalledOnce();
  });
});
