import { describe, expect, it } from "vitest";
import { buildGeminiInteractionsRequest } from "../../../providers/geminiInteractionsRequest";
import { buildOpenRouterChatRequest } from "../../../providers/openRouterChatRequest";
import type { ProviderExecutionSnapshot } from "../../../providers/runtimeFactory";
import type { RunTool } from "../../../tools/types";
import { MEMORY_FACT_SOURCE_PROJECTION_VERSION, type MemoryFactExtractionInput } from "./contract";
import { memoryFactExtractionTool } from "./prompt";
import { memoryFactExtractionProviderTool } from "./providerSchema";
import { buildMemoryFactExtractionRequest } from "./runtime";

const source: MemoryFactExtractionInput = {
  contextRefs: [], folderId: null, identityProfile: "UNICODE_V2", inputHash: "a".repeat(64),
  messages: [{
    contentHash: "b".repeat(64), createdAt: "2026-09-17T10:00:00.000Z",
    evidenceEligible: true, id: "message-1", languageCode: "en", redactionSpans: [],
    role: "user", text: "I prefer short answers.", updatedAt: "2026-09-17T10:00:00.000Z"
  }],
  source: {
    activeLeafMessageId: "message-1", branchGeneration: 1, chatId: "chat-1",
    memoryGenerationSnapshot: 1, sourceHash: "b".repeat(64), sourceMessageId: "message-1",
    sourceRevision: 1, userId: "user-1"
  },
  sourceProjectionHash: "c".repeat(64), sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
  suppressionIdentitySnapshot: "d".repeat(64), timeZone: "UTC"
};

function snapshot(native: boolean): ProviderExecutionSnapshot {
  return {
    connection: {
      allowPrivateNetwork: false, apiRoot: "https://provider.example.test/v1",
      authenticationMode: "bearer", responseTimeoutMs: 120_000
    },
    connectionDisplayName: "Synthetic", connectionId: "connection-1",
    credentialId: "credential-1", credentialVersionId: "version-1",
    model: {
      adapterKind: native ? "gemini_interactions_native" : "openrouter_chat_completions",
      answerSelectable: true,
      capabilities: {
        nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true,
        reasoningEfforts: ["low", "medium", "high"], streaming: false, toolCalling: true, vision: false
      },
      defaultParams: { reasoning: { effort: "low" } }, modelClass: "answer",
      upstreamModelId: native ? "gemini-3.8-flash" : "google/gemini-3.8-flash"
    },
    modelDisplayName: "Gemini", providerFamily: native ? "gemini" : "openrouter",
    providerModelId: "model-1", version: 1
  };
}

describe("Memory extraction provider schema", () => {
  it.each([true, false])("projects only array bounds and constant tags on the production request (native=%s)", (native) => {
    const original = structuredClone(memoryFactExtractionTool);
    type Point = { properties: { kind: { const?: string; enum?: string[] } } };
    const expected = JSON.parse(JSON.stringify(original.inputSchema)) as {
      properties: { observations: { maxItems?: number; items: { properties: {
        dependency_refs: { maxItems?: number };
        entities: { maxItems?: number; items: { properties: {
          aliases: { maxItems?: number }; qualifier_supports: { maxItems?: number };
        } } };
        temporal: { properties: { normalization: { anyOf: Array<Point & {
          properties: { start?: { anyOf: Point[] }; end?: { anyOf: Point[] } };
        }> } } };
      } } } };
    };
    const observations = expected.properties.observations;
    const fields = observations.items.properties;
    delete observations.maxItems;
    delete fields.dependency_refs.maxItems;
    delete fields.entities.maxItems;
    delete fields.entities.items.properties.aliases.maxItems;
    delete fields.entities.items.properties.qualifier_supports.maxItems;
    const normalization = fields.temporal.properties.normalization.anyOf;
    const discriminators = [
      ...normalization,
      ...normalization[4]!.properties.start!.anyOf,
      ...normalization[4]!.properties.end!.anyOf
    ];
    expect(discriminators).toHaveLength(13);
    for (const branch of discriminators) {
      expect(branch.properties.kind.const).toEqual(expect.any(String));
      branch.properties.kind.enum = [branch.properties.kind.const!];
      delete branch.properties.kind.const;
    }

    const request = buildMemoryFactExtractionRequest(snapshot(native), source);
    expect(request).toMatchObject({
      forceNonStreaming: true, parallelToolCalls: false, toolChoice: "required",
    });
    expect(request.tools).toEqual([{ ...original, inputSchema: expected }]);
    if (native) {
      expect(buildGeminiInteractionsRequest(request)).toMatchObject({
        generation_config: { thinking_level: "low", tool_choice: "any" },
        store: false, stream: false,
        tools: [{ name: original.name, parameters: expected, type: "function" }]
      });
    } else {
      expect(buildOpenRouterChatRequest(request)).toMatchObject({
        stream: false, tool_choice: "required",
        tools: [{ function: { name: original.name, parameters: expected, strict: true }, type: "function" }]
      });
    }
    expect(memoryFactExtractionTool).toEqual(original);
  });

  it.each([
    ["gemini_interactions_native", "gemini-3.5-flash"],
    ["openrouter_chat_completions", "google/gemini-3.5-flash"],
    ["openrouter_chat_completions", "deepseek/deepseek-v4.1-flash"],
    ["deepseek_responses_native", "deepseek-flash"],
    ["openai_responses_compatible", "gpt-5.6-terra"],
    ["openai_chat_completions_compatible", "google/gemini-3.8-flash"]
  ] as const)("preserves the canonical tool for %s / %s", (adapterKind, upstreamModelId) => {
    expect(memoryFactExtractionProviderTool({ adapterKind, upstreamModelId }, memoryFactExtractionTool))
      .toBe(memoryFactExtractionTool);
  });

  it("preserves payload fields and literal data named maxItems", () => {
    const tool: RunTool = {
      ...memoryFactExtractionTool,
      inputSchema: {
        additionalProperties: false,
        properties: {
          maxItems: { anyOf: [{ items: { type: "string" }, maxItems: 2, type: "array" }, { type: "null" }] },
          literal: { const: { maxItems: 3 }, enum: [{ maxItems: 3 }] }
        },
        required: ["maxItems", "literal"], type: "object"
      }
    };
    const original = structuredClone(tool);
    const projected = memoryFactExtractionProviderTool(snapshot(true).model, tool);
    expect(projected.inputSchema).toEqual({
      additionalProperties: false,
      properties: {
        maxItems: { anyOf: [{ items: { type: "string" }, type: "array" }, { type: "null" }] },
        literal: { const: { maxItems: 3 }, enum: [{ maxItems: 3 }] }
      },
      required: ["maxItems", "literal"], type: "object"
    });
    expect(tool).toEqual(original);
  });

  it("keeps a constant tag stricter than an overlapping enum and rejects a contradictory enum", () => {
    const tool = (values: string[]): RunTool => ({
      ...memoryFactExtractionTool,
      inputSchema: {
        type: "object", additionalProperties: false, required: ["kind"],
        properties: { kind: { enum: values, const: "NONE", type: "string" } }
      }
    });
    expect(memoryFactExtractionProviderTool(snapshot(true).model, tool(["NONE", "OTHER"]))
      .inputSchema).toMatchObject({ properties: { kind: { enum: ["NONE"], type: "string" } } });
    expect(() => memoryFactExtractionProviderTool(snapshot(true).model, tool(["OTHER"])))
      .toThrow("memory_fact_provider_schema_invalid");
  });
});
