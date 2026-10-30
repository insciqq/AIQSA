import { describe, expect, it, vi } from "vitest";
import { WorkspaceBrowserAgentIdentity, workspaceBrowserAgentAvailableFor } from "./browserAgentIdentity";

describe("Workspace browser agent identity", () => {
  it("forwards release as the agent-owned browser exec", async () => {
    const callBoundTool = vi.fn(async () => ({ content: [], status: "complete" as const }));
    const identity = new WorkspaceBrowserAgentIdentity({
      operation: { generation: 1, owner: "run:fixture" }, runtime: { callBoundTool }, runtimeSandboxId: "sandbox", sessionId: "session"
    });
    const agent = { kind: "subagent" as const, name: "shop-amazon", threadId: "thread-7" };
    await identity.release({ agent, chatId: "chat", modelRunId: "run", userId: "user" });
    expect(callBoundTool).toHaveBeenCalledWith(expect.objectContaining({ agent, originalName: "sandbox_exec",
      arguments: { command: "aiqsa-browser", args: ["release"] }, modelRunId: "run" }));
  });

  it("treats old images as main-only", () => {
    expect(workspaceBrowserAgentAvailableFor({ kind: "main" }, "aiqsa-workspace:0.1.39")).toBe(true);
    expect(workspaceBrowserAgentAvailableFor({ kind: "subagent", name: "shop", threadId: "thread-7" }, "aiqsa-workspace:0.1.39")).toBe(false);
    expect(workspaceBrowserAgentAvailableFor({ kind: "subagent", name: "shop", threadId: "thread-7" }, "aiqsa-workspace:0.1.40")).toBe(true);
  });
});
