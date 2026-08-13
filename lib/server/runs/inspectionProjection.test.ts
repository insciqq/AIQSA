import { describe, expect, it } from "vitest";
import { projectModelRunInspection } from "./inspectionProjection";

describe("projectModelRunInspection", () => {
  it("projects exact accepted controls and safe labels without request content or identities", () => {
    const projection = projectModelRunInspection({
      acceptedAt: new Date("2026-08-13T11:32:05.000Z"),
      answerMessageId: "assistant-private-id",
      normalizedRequest: {
        attachmentIds: ["attachment-private-1", "attachment-private-2"],
        chatId: "chat-private-id",
        content: {
          blocks: [{ text: "password=private-secret", type: "text" }]
        },
        context: {
          messages: [{ content: "private history" }, { content: "more history" }],
          mode: "branch_path"
        },
        knowledgePlan: { baseIds: ["base-private-id"] },
        mcp: {
          servers: [{
            externalAccountLabel: "Finance workspace",
            fingerprint: "fingerprint-private",
            revisionId: "revision-private",
            serverId: "server-private-id",
            serverName: "office-compute"
          }],
          tools: [{
            inputSchema: { properties: { apiKey: { type: "string" } } },
            namespacedName: "mcp_internal_private_hash",
            originalName: "create_workbook",
            serverId: "server-private-id",
            serverName: "office-compute"
          }],
          version: 1
        },
        memoryActionTools: { version: "model-driven-v2" },
        memoryHistoryTool: { maxCalls: 2, pageSize: 20 },
        params: {
          background: false,
          max_completion_tokens: 1_200,
          reasoning: { effort: "medium", encrypted: "private-signature" },
          stream: true,
          temperature: 0.7
        },
        personalContext: {
          itemCount: 2,
          text: "private frozen memory"
        },
        prompt: { system: "private system prompt" },
        searchPlan: {
          mode: "all_selected",
          options: [{
            config: { apiKey: "private-search-key" },
            displayName: "Installation Search",
            optionId: "search-private-id"
          }]
        },
        toolMode: "auto"
      }
    });

    expect(projection).toEqual({
      acceptedAt: "2026-08-13T11:32:05.000Z",
      answerMessageId: "assistant-private-id",
      attachmentCount: 2,
      branchMessageCount: 2,
      firstPartyTools: ["Memory actions", "Memory search"],
      knowledgeBaseCount: 1,
      mcpServers: [{
        externalAccountLabel: "Finance workspace",
        name: "office-compute",
        toolNames: ["create_workbook"]
      }],
      memoryContextItemCount: 2,
      parameters: [
        { name: "max_output_tokens", value: 1_200 },
        { name: "temperature", value: 0.7 },
        { name: "background", value: false },
        { name: "stream", value: true },
        { name: "reasoning_effort", value: "medium" }
      ],
      searchBindings: [{ displayName: "Installation Search" }],
      searchMode: "all_selected",
      toolMode: "auto"
    });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toMatch(
      /private-secret|chat-private|attachment-private|base-private|fingerprint-private|revision-private|server-private|private_hash|private-signature|private frozen|private system|private-search-key|search-private/u
    );
  });

  it("fails closed to bounded neutral facts when legacy request shapes are malformed", () => {
    const projection = projectModelRunInspection({
      acceptedAt: new Date("2026-08-13T00:00:00.000Z"),
      answerMessageId: null,
      normalizedRequest: {
        attachmentIds: [null, 7],
        mcp: {
          servers: [{ serverName: "bad\nname" }],
          tools: "not-an-array"
        },
        params: { temperature: Number.POSITIVE_INFINITY },
        searchPlan: { mode: "unknown", options: [] },
        toolMode: "unexpected"
      }
    });

    expect(projection).toMatchObject({
      answerMessageId: null,
      attachmentCount: 0,
      mcpServers: [],
      parameters: [],
      searchBindings: [],
      searchMode: null,
      toolMode: "auto"
    });
  });
});
