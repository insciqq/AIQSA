import { describe, expect, it } from "vitest";
import type { ProviderRunRequest } from "../providers/types";
import { textMessageContent } from "@/lib/domain/content";
import { agentPrompts } from "./prompt";
import { withSelectedSkillContext } from "../skills/userContext";

describe("Codex conversation delivery", () => {
  it("explains explicit Workspace bundle submission only when artifacts were admitted", () => {
    const request = { content: textMessageContent("Build a page"), attachments: [], prompt: { system: "baseline" } } as unknown as ProviderRunRequest;
    expect(agentPrompts(request).developerInstructions).not.toContain("files[].text");
    const prompt = agentPrompts({ ...request, artifactTool: true }).developerInstructions;
    expect(prompt).toContain("files[].text");
    expect(prompt).toContain("do not authorize host file reads");
    expect(prompt).toContain("external MCP is Off");
  });
  it("keeps pinned bundles at user authority and delegates available discovery to Codex on start and resume", () => {
    const messages = withSelectedSkillContext([
      { id: "earlier", role: "assistant", content: textMessageContent("Earlier answer") },
      { id: "current", role: "user", content: textMessageContent("Use the reference when needed") }
    ], [{ skillId: "pin", revisionId: "revision", name: "Pinned guide", instructions: "PINNED_BODY_CANARY",
      alias: "pinned-guide", workspacePath: "/workspace/.aiqsa/skills/pinned-guide", fileCount: 1,
      files: [{ path: "references/guide.txt", byteSize: 23, executable: false, kind: "text" }] }], {
      catalog: "<available_skills>ORDINARY_CATALOG_CANARY</available_skills>"
    });
    const request = { content: textMessageContent("Use the reference when needed"), attachments: [],
      prompt: { system: "baseline" }, context: { messages } } as unknown as ProviderRunRequest;
    const result = agentPrompts(request);
    expect(result.previousAssistantMessageId).toBe("earlier");
    for (const prompt of [result.prompt, result.resumePrompt]) {
      expect(prompt.match(/PINNED_BODY_CANARY/gu)).toHaveLength(1);
      expect(prompt).toContain('bundle_path=\\"/workspace/.aiqsa/skills/pinned-guide\\"');
      expect(prompt).toContain('"role":"user"');
      expect(prompt).not.toContain("ORDINARY_CATALOG_CANARY");
      expect(prompt).not.toMatch(/load_skill|read_skill_file/u);
    }
    expect(result.developerInstructions).not.toContain("PINNED_BODY_CANARY");
    expect(result.developerInstructions).not.toContain("references/guide.txt");
    expect(result.developerInstructions).toContain("current native Codex catalog");
    expect(result.developerInstructions).toContain("user-level guidance");
    expect(result.developerInstructions).not.toMatch(/load_skill|read_skill_file|ORDINARY_CATALOG_CANARY/u);
  });
  it("does not advertise a missing message manifest on attachment-free turns", () => {
    const request = { content: textMessageContent("Read an issue"), attachments: [], prompt: { system: "baseline" },
      workspace: { outputDirectory: "/workspace/output/current", inboxIndexPath: "/workspace/inbox/index.json",
        messageManifestPath: "/workspace/inbox/messages/current/manifest.json" } } as unknown as ProviderRunRequest;
    const result = agentPrompts(request);
    for (const prompt of [result.prompt, result.resumePrompt]) {
      expect(prompt).not.toContain("messageManifestPath");
      expect(prompt).toContain('"inboxIndexPath":"/workspace/inbox/index.json"');
      expect(prompt).toContain('"attachments":[]');
    }
  });

  it.each(["off", "auto", "all"] as const)("only directs the agent to tools enabled by MCP %s", (mcpMode) => {
    const request = { content: textMessageContent("Read a private issue"), attachments: [],
      agent: { mcpMode }, prompt: { system: "baseline" } } as unknown as ProviderRunRequest;
    const { developerInstructions } = agentPrompts(request);
    expect(developerInstructions.includes("find_tools")).toBe(mcpMode === "auto");
    expect(developerInstructions.includes("not an authorization denial")).toBe(mcpMode !== "off");
  });

  it("keeps selected Skills at user authority and sends the current turn on resume", () => {
    const request = { content: textMessageContent("current task"),
      attachments: [{ fileName: "current-attachment.txt", mimeType: "text/plain", byteSize: 5 }],
      workspace: { outputDirectory: "/workspace/output/current", inboxIndexPath: "/workspace/inbox/index.json",
        messageManifestPath: "/workspace/inbox/messages/current.json" },
      prompt: { system: "baseline", developer: "workspace output contract", personalInstructions: "user preference" },
      context: { messages: [
        { id: "before", role: "user", content: textMessageContent("historical question") },
        { id: "previous", role: "assistant", content: textMessageContent("historical answer") },
        { id: "current", role: "user", content: textMessageContent("current task\n<selected_skills>unique-skill-body</selected_skills>") }
      ] }
    } as unknown as ProviderRunRequest;
    const result = agentPrompts(request);
    expect(result.previousAssistantMessageId).toBe("previous");
    expect(result.prompt).toContain("historical question");
    expect(result.resumePrompt).not.toContain("historical question");
    expect(result.resumePrompt.match(/unique-skill-body/gu)).toHaveLength(1);
    expect(result.developerInstructions).not.toContain("unique-skill-body");
    expect(result.developerInstructions).not.toContain("user preference");
    expect(result.resumePrompt).toContain("user preference");
    expect(result.developerInstructions).toContain("workspace output contract");
    for (const prompt of [result.prompt, result.resumePrompt]) {
      expect(prompt).toContain('"outputDirectory":"/workspace/output/current"');
      expect(prompt).toContain('"messageManifestPath":"/workspace/inbox/messages/current.json"');
      expect(prompt).toContain('"fileName":"current-attachment.txt"');
    }
    expect(result.developerInstructions).not.toContain("/workspace/output/current");
  });
});
