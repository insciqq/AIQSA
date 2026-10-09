import { describe, expect, it } from "vitest";
import type { WorkspaceRunAdmissionPlan } from "./admission";
import { WORKSPACE_WEBSITE_ACTION_SAFETY } from "./browserGuidance";
import { WORKSPACE_GUIDE_FILES, WORKSPACE_GUIDE_PATHS } from "./guides";
import { WORKSPACE_NO_REPLAY_SAFETY, workspacePromptContract } from "./promptContract";

const workspace: WorkspaceRunAdmissionPlan = {
  assistantMessageId: "answer", chatId: "chat", expiresAt: "2026-01-01T00:00:00.000Z", policyRevision: 1,
  runId: "run", sandboxName: "sandbox", sessionId: "session", userMessageId: "question", toolDefinitions: [],
  normalized: { enabled: true, imageRef: "fixture", inboxIndexPath: "/workspace/inbox/index.json", internetEnabled: false,
    mcpVersion: "fixture", maxToolCalls: 30, maxToolRounds: 12, messageManifestPath: "/workspace/inbox/messages/current/manifest.json",
    outputDirectory: "/workspace/output/current", projectDirectory: "/workspace/project", runtimeVersion: "fixture", sessionId: "session",
    syncToolTimeoutSeconds: 60, toolCatalogHash: "a".repeat(64), turnTimeoutSeconds: 600 }
};
const base = { workspace, agent: false, currentAttachmentCount: 0, hasIndexedFiles: false,
  hasEarlierExports: false, searchEnabled: false, fileContext: "owned file references" };
const render = (input: Parameters<typeof workspacePromptContract>[0]) => {
  const contract = workspacePromptContract(input);
  return `${contract.stable}\n${contract.turn}`;
};

describe("Workspace capability contract", () => {
  it("offers direct answers and execution without requiring an unused guest or embedding guide bodies", () => {
    const text = render(base);
    expect(text).toContain("It starts on first use.");
    expect(text).toContain("When correctness depends on a computation, run it rather than guess.");
    expect(text).toContain("Try to answer directly first;");
    expect(text).toContain("After changing code or files in the Workspace, run appropriate tests or checks.");
    expect(text).toContain("Do not claim that a file was created or a check passed until a tool verified it.");
    // Exported files become downloads; nothing suggests they are published as anything more.
    expect(text).toContain("the interface lists successfully exported files as downloads automatically.");
    expect(text).not.toContain("publishes");
    expect(text).toContain("/workspace/SECRETS.md");
    expect(text).toContain(WORKSPACE_WEBSITE_ACTION_SAFETY);
    expect(text).toContain(`Before building, changing or saving a reusable script Skill, read ${WORKSPACE_GUIDE_PATHS.skills}.`);
    for (const file of WORKSPACE_GUIDE_FILES) {
      expect(text.split(file.path)).toHaveLength(2);
      expect(text).not.toContain(file.content);
    }
    expect(text).not.toContain("Workspace is active");
    expect(text).not.toContain("Current message manifest");
    expect(text).not.toContain("owned file references");
    expect(text).not.toContain("earlier completed exports");
    expect(text).not.toContain("Web search is available");
  });

  it.each([false, true])("includes file, export, attachment and Search fragments only for admitted facts (agent=%s)", agent => {
    for (const enabled of [false, true]) {
      const text = render({ ...base, agent, hasIndexedFiles: enabled, hasEarlierExports: enabled,
        currentAttachmentCount: enabled ? 1 : 0, searchEnabled: enabled });
      expect(text.includes("owned file references")).toBe(enabled);
      expect(text.includes("earlier completed exports")).toBe(enabled);
      expect(text.includes(agent ? "Read messageManifestPath" : "Current message manifest")).toBe(enabled);
      expect(text.includes("Web search is available in this chat as its own tool.")).toBe(enabled);
      expect(text).toContain("Internet inside the workspace: disabled.");
    }
  });

  it("keeps the stable prefix before changing output paths, network and file context", () => {
    const first = workspacePromptContract(base);
    const second = workspacePromptContract({ ...base, hasIndexedFiles: true, currentAttachmentCount: 1, hasEarlierExports: true,
      searchEnabled: true, workspace: { ...workspace,
        normalized: { ...workspace.normalized, outputDirectory: "/workspace/output/next", internetEnabled: true } } });
    expect(first.stable).toBe(second.stable);
    for (const turn of [first.turn, second.turn]) expect(turn.startsWith("This turn's output directory:")).toBe(true);
    expect(first.stable).not.toContain("/workspace/output/");
    expect(second.turn).toContain("Internet inside the workspace: enabled (public destinations only).");
    expect(second.turn).toContain("owned file references");
    expect(second.stable).not.toContain("owned file references");
  });

  it.each([false, true])("renders admission lines before chat facts so a PDF retry can replace them in a frozen turn (agent=%s)", agent => {
    const neutral = workspacePromptContract({ ...base, agent, currentAttachmentCount: 1 });
    const facts = workspacePromptContract({ ...base, agent, currentAttachmentCount: 1, hasIndexedFiles: true,
      hasEarlierExports: true, searchEnabled: true });
    expect(facts.stable).toBe(neutral.stable);
    expect(facts.turn.startsWith(`${neutral.turn}\n`)).toBe(true);
  });

  it.each([false, true])("gives every run the no-replay sentence in the stable part, with or without files (agent=%s)", agent => {
    for (const hasIndexedFiles of [false, true]) {
      const contract = workspacePromptContract({ ...base, agent, hasIndexedFiles, currentAttachmentCount: hasIndexedFiles ? 1 : 0 });
      expect(contract.stable.split(WORKSPACE_NO_REPLAY_SAFETY)).toHaveLength(2);
      expect(contract.turn).not.toContain(WORKSPACE_NO_REPLAY_SAFETY);
      expect(contract.stable.indexOf(WORKSPACE_NO_REPLAY_SAFETY)).toBeGreaterThan(contract.stable.indexOf(WORKSPACE_WEBSITE_ACTION_SAFETY));
    }
  });

  it("keeps Agent inside its Workspace and takes turn paths from the refreshed user prompt", () => {
    const text = render({ ...base, agent: true });
    expect(text).toContain("You are working inside this chat's Workspace");
    expect(text).toContain("native Codex equivalents");
    expect(text).toContain("Read outputDirectory from the current AIQSA turn workspace paths.");
    expect(text).not.toContain("Answer directly"); expect(text).not.toContain("Try to answer directly");
    expect(text).not.toContain("It starts on first use");
    expect(text).not.toContain(workspace.normalized.outputDirectory);
    expect(text).toContain(WORKSPACE_WEBSITE_ACTION_SAFETY);
  });
});
