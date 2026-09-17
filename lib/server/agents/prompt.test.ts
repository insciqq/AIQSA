import { describe, expect, it } from "vitest";
import type { ProviderRunRequest } from "../providers/types";
import { textMessageContent } from "@/lib/domain/content";
import { agentPrompts } from "./prompt";

describe("Codex conversation delivery", () => {
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
