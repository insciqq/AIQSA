import { describe, expect, it, vi } from "vitest";
import type { ProviderRunRequest } from "../providers/types";
import { openAIResponsesToolBridge } from "../tools/bridges";
import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import { SkillBundleError } from "./bundleErrors";
import { createSkillToolResultBudget } from "./toolResultBudget";
import { deliverSkillWorkspaceBundle } from "./workspaceDelivery";

function fixture() {
  const request = { attachmentIds: [], attachments: [], chatId: "chat", content: { blocks: [{ type: "text", text: "Question" }] },
    knowledgePlan: { baseIds: [], sourceIds: [], mode: "none", version: 1 },
    modelCapabilities: { contextWindow: 6_000, defaultMaxOutputTokens: 512, nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
    modelId: "model", provider: "openai", params: {}, prompt: { system: null, developer: null },
    searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto", workspace: {
      enabled: true, imageRef: "synthetic", inboxIndexPath: "/workspace/inbox/index.json", internetEnabled: false,
      mcpVersion: "0.6.16", maxToolCalls: 80, maxToolRounds: 40,
      messageManifestPath: "/workspace/inbox/messages/message/manifest.json", outputDirectory: "/workspace/output/run",
      projectDirectory: "/workspace/project", runtimeVersion: "0.6.16", sessionId: "session",
      syncToolTimeoutSeconds: 120, toolCatalogHash: "a".repeat(64), turnTimeoutSeconds: 1800
    }
  } satisfies ProviderRunRequest;
  const path = "/workspace/.aiqsa/skills/review";
  const skillBundlePath = vi.fn(async () => path);
  const coordinator = { skillBundlePath } as unknown as WorkspaceCoordinator;
  const call: ModelToolCall = { id: "call", name: "load_skill", arguments: { skill: "review" } };
  const result: ToolExecutionResult = { callId: call.id, name: call.name, status: "complete",
    content: [{ type: "json", value: { instructions: "Read bundled references.", workspacePath: path } }] };
  return { request, coordinator, skillBundlePath, call, result, path, runId: "run", userId: "user", signal: new AbortController().signal };
}

describe("post-budget Workspace Skill delivery", () => {
  it("performs no runtime I/O for a context-rejected Skill", async () => {
    const f = fixture();
    const result: ToolExecutionResult = { ...f.result, content: [{ type: "json", value: { instructions: "x".repeat(100_000), workspacePath: f.path } }] };
    const budget = createSkillToolResultBudget();
    budget.begin({ request: f.request, calls: [f.call], bridge: openAIResponsesToolBridge });
    const admitted = budget.accept(result);
    expect(admitted).toMatchObject({ status: "error", content: [{ value: { error: "skill_too_large_for_context" } }] });
    expect(await deliverSkillWorkspaceBundle({ ...f, result: admitted })).toBe(admitted);
    expect(f.skillBundlePath).not.toHaveBeenCalled();
  });

  it("awaits successful installation before exposing the path, and only checks preparation for binary reads", async () => {
    const f = fixture();
    expect(await deliverSkillWorkspaceBundle(f)).toBe(f.result);
    expect(f.skillBundlePath).toHaveBeenCalledWith(expect.objectContaining({ alias: "review", install: true }));
    const call = { ...f.call, name: "read_skill_file", arguments: { skill: "review", path: "assets/data.bin" } };
    const result: ToolExecutionResult = { ...f.result, name: call.name, status: "error",
      content: [{ type: "json", value: { error: "skill_file_binary", workspacePath: `${f.path}/assets/data.bin` } }] };
    expect(await deliverSkillWorkspaceBundle({ ...f, call, result })).toBe(result);
    expect(f.skillBundlePath).toHaveBeenLastCalledWith(expect.objectContaining({ install: false }));
  });

  it("turns revocation/install failure into a safe unsuccessful result without a load binding", async () => {
    const f = fixture();
    f.skillBundlePath.mockRejectedValueOnce(new Error("PRIVATE_FAILURE_CANARY"));
    expect(await deliverSkillWorkspaceBundle(f)).toMatchObject({ status: "error", content: [{ value: { error: "skill_workspace_unavailable" } }] });
    f.skillBundlePath.mockRejectedValueOnce(new SkillBundleError({ code: "skill_not_available" }));
    expect(await deliverSkillWorkspaceBundle(f)).toMatchObject({ status: "error", content: [{ value: { error: "skill_not_available" } }] });
    const controller = new AbortController(); controller.abort(new Error("stop"));
    await expect(deliverSkillWorkspaceBundle({ ...f, signal: controller.signal })).rejects.toThrow("stop");
    expect(f.skillBundlePath).toHaveBeenCalledTimes(2);
  });
});
