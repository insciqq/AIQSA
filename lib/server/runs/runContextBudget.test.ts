import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderRunRequest } from "../providers/types";
import { openAIResponsesToolBridge } from "../tools/bridges";
import {
  applyProviderRequestContextBudget,
  providerFacingSerializedTools
} from "./runContextBudget";

function request(overrides: Partial<ProviderRunRequest> = {}): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "chat-1",
    content: { blocks: [{ text: "question", type: "text" }] },
    context: {
      messages: [{
        content: { blocks: [{ text: "question", type: "text" }] },
        id: "current",
        role: "user"
      }],
      mode: "branch_path"
    },
    modelCapabilities: {
      contextWindow: 100,
      defaultMaxOutputTokens: 0,
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      vision: false
    },
    modelId: "gpt-test",
    params: {},
    prompt: { developer: null, system: null },
    provider: "openai",
    searchStrategy: null,
    ...overrides
  };
}

describe("provider request context budget", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("counts the exact serialized provider tool schema", () => {
    const tool = {
      capability: "mcp" as const,
      description: "d".repeat(500),
      inputSchema: { properties: { value: { type: "string" } }, type: "object" },
      name: "mcp_memory_store"
    };
    const input = request({ tools: [tool] });

    expect(providerFacingSerializedTools(input, openAIResponsesToolBridge)).toEqual([
      openAIResponsesToolBridge.serializeTool(tool).tool
    ]);
    expect(applyProviderRequestContextBudget({
      bridge: openAIResponsesToolBridge,
      request: input
    })).toMatchObject({ error: { code: "context_too_large" }, ok: false });
  });

  it("counts provider-hosted tools through the provider bridge", () => {
    const input = request({ searchStrategy: "openai-native-web-search" });

    expect(providerFacingSerializedTools(input, openAIResponsesToolBridge)).toEqual([
      { type: "web_search" }
    ]);
  });

  it("counts prompt, current content, and tools when the first turn has no context rows", () => {
    const budgeted = applyProviderRequestContextBudget({
      bridge: openAIResponsesToolBridge,
      request: request({
        context: { messages: [], mode: "branch_path" },
        tools: [{
          capability: "mcp",
          description: "d".repeat(500),
          inputSchema: { type: "object" },
          name: "mcp_first_turn"
        }]
      })
    });

    expect(budgeted).toMatchObject({ error: { code: "context_too_large" }, ok: false });
  });

  it("counts the retained provider tool transcript on continuation rounds", () => {
    const budgeted = applyProviderRequestContextBudget({
      bridge: openAIResponsesToolBridge,
      request: request({
        providerToolMessages: [{
          call_id: "call-1",
          output: "r".repeat(500),
          type: "function_call_output"
        }]
      })
    });

    expect(budgeted).toMatchObject({ error: { code: "context_too_large" }, ok: false });
  });

  it("derives attachment text length from the selected model context window", () => {
    const attachment = {
      byteSize: 100_000,
      extractedText: "a".repeat(30_000),
      fileName: "long.txt",
      id: "attachment-1",
      kind: "document",
      metadata: {},
      mimeType: "text/plain",
      status: "ready"
    };
    const small = applyProviderRequestContextBudget({
      request: request({
        attachmentIds: [attachment.id],
        attachments: [attachment],
        modelCapabilities: {
          ...request().modelCapabilities,
          contextWindow: 1_000
        }
      })
    });
    const large = applyProviderRequestContextBudget({
      request: request({
        attachmentIds: [attachment.id],
        attachments: [attachment],
        modelCapabilities: {
          ...request().modelCapabilities,
          contextWindow: 100_000
        }
      })
    });

    expect(small.ok).toBe(true);
    expect(large.ok).toBe(true);
    if (!small.ok || !large.ok) throw new Error("unexpected budget rejection");
    expect(small.request.attachments[0]!.extractedText!.length).toBeLessThan(30_000);
    expect(small.request.attachments[0]!.extractedText).toContain("[truncated for model context]");
    expect(large.request.attachments[0]!.extractedText).toBe(attachment.extractedText);
  });

  it("fits non-ASCII attachment text by estimated tokens rather than raw characters", () => {
    const attachment = {
      byteSize: 10_000,
      extractedText: "Ж".repeat(2_000),
      fileName: "notes.txt",
      id: "attachment-1",
      kind: "document",
      metadata: {},
      mimeType: "text/plain",
      status: "ready"
    };
    const budgeted = applyProviderRequestContextBudget({
      request: request({
        attachmentIds: [attachment.id],
        attachments: [attachment],
        modelCapabilities: { ...request().modelCapabilities, contextWindow: 1_000 }
      })
    });

    expect(budgeted.ok).toBe(true);
    if (!budgeted.ok) throw new Error("unexpected budget rejection");
    expect(budgeted.request.attachments[0]!.extractedText!.length).toBeLessThan(1_000);
  });

  it("honors the reduction-only operator clamp without restoring a fixed provider cap", () => {
    vi.stubEnv("AIQSA_ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS", "10");
    const text = "abcdefghijklmnopqrstuvwxyz";
    const budgeted = applyProviderRequestContextBudget({
      request: request({
        attachments: [{
          byteSize: text.length,
          extractedText: text,
          fileName: "notes.txt",
          id: "attachment-1",
          kind: "document",
          metadata: {},
          mimeType: "text/plain",
          status: "ready"
        }],
        modelCapabilities: { ...request().modelCapabilities, contextWindow: 100_000 }
      })
    });

    expect(budgeted.ok).toBe(true);
    if (!budgeted.ok) throw new Error("unexpected budget rejection");
    expect(budgeted.request.attachments[0]!.extractedText).toBe("abcdefghij\n[truncated 16 chars]");
  });
});
