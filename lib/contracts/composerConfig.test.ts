import { describe, expect, it } from "vitest";
import type { ComposerConfigResponse } from "./composerConfig";
import { decodeComposerConfigResponse } from "./composerConfig";

function response(): ComposerConfigResponse {
  return {
    composerConfig: {
      assistants: [{
        archived: false,
        availability: { ok: true },
        avatar: {
          accents: [1],
          backgroundShape: "circle",
          foregroundShape: "ring",
          kind: "generated",
          paletteId: "ember",
          recipeVersion: 1,
          rotations: [0, 1]
        },
        category: "research",
        description: "Finds and compares sources.",
        fingerprint: {
          mcpServerCount: 1,
          modelLabel: "GPT Test",
          reasoningEffort: "medium",
          searchOptionCount: 1
        },
        id: "assistant-1",
        name: "Researcher",
        owned: true,
        ownerDisplayName: "Viewer",
        pinned: true,
        published: false,
        revisionNumber: 2,
        scope: { kind: "owner" },
        starterPrompts: ["Compare the evidence"],
        updatedAt: "2026-08-13T10:00:00.000Z"
      }],
      catalog: {
        attachmentLimits: {
          maxCount: 20,
          maxEncodedBytes: 100_663_296,
          maxMaterializedBytes: 67_108_864
        },
        defaults: {
          controlValues: {},
          hasPersonalModelDefault: true,
          modelId: "deployment-test",
          modelPreferenceSource: "personal",
          organizationModelDefault: null,
          organizationSearchPlan: { mode: "all_selected", optionIds: [] },
          personalModelDefault: {
            modelId: "deployment-test",
            provider: "connection-test"
          },
          provider: "connection-test",
          searchPlan: { mode: "all_selected", optionIds: [] },
          searchPreferenceSource: "personal",
          searchStrategyId: "search-disabled",
          showCitations: true,
          showReasoningBlocks: false,
          showToolActivity: true
        },
        models: [{
          capabilities: {
            background: true,
            documentInputMode: "none",
            imageInput: false,
            nativeWebSearch: false,
            openRouterPerplexitySearch: false,
            reasoning: true,
            streaming: true,
            text: true,
            toolCalling: true
          },
          contextWindow: 128_000,
          defaultParams: {},
          displayName: "GPT Test",
          modelId: "deployment-test",
          parameterControls: {
            background: { defaultValue: true, supported: true },
            maxOutputTokens: { defaultValue: 1_024, maxValue: 4_096 },
            reasoningEffort: {
              defaultValue: "medium",
              options: ["low", "medium", "high"],
              supported: true
            },
            stream: { defaultValue: false, supported: true },
            temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
          },
          provider: "connection-test",
          providerFamily: "openai",
          searchStrategyIds: ["search-disabled", "web-test"],
          upstreamModelId: "gpt-test"
        }],
        providers: [{
          family: "openai",
          id: "connection-test",
          models: ["deployment-test"],
          name: "OpenAI workspace"
        }],
        searchStrategies: [{
          displayName: "No Search",
          kind: "none",
          strategyId: "search-disabled"
        }, {
          description: "Current web sources",
          displayName: "Web Search",
          kind: "web_search",
          strategyId: "web-test"
        }]
      },
      knowledgeBases: [{
        archived: false,
        description: "Product evidence",
        id: "knowledge-1",
        name: "Product docs",
        owned: true
      }],
      mcpServers: [{
        description: "Creates office files",
        enabled: true,
        id: "mcp-1",
        knownToolCount: 3,
        name: "office-compute",
        readiness: "ready"
      }]
    }
  };
}

describe("composer-config wire contract", () => {
  it("decodes the four bounded safe projections", () => {
    const decoded = decodeComposerConfigResponse(response());

    expect(decoded).toMatchObject({
      assistants: [{ id: "assistant-1", name: "Researcher" }],
      catalog: { models: [{ displayName: "GPT Test" }] },
      knowledgeBases: [{ id: "knowledge-1", name: "Product docs" }],
      mcpServers: [{ id: "mcp-1", readiness: "ready" }]
    });
  });

  it("fails closed for accidental aggregate fields and malformed summaries", () => {
    const leaked = structuredClone(response()) as ComposerConfigResponse & {
      composerConfig: { credentialLabel?: string };
    };
    leaked.composerConfig.credentialLabel = "must-not-project";
    expect(decodeComposerConfigResponse(leaked)).toBeNull();

    const malformed = structuredClone(response()) as unknown as {
      composerConfig: { mcpServers: Array<Record<string, unknown>> };
    };
    malformed.composerConfig.mcpServers[0]!.accountLabel = "hidden-account";
    expect(decodeComposerConfigResponse(malformed)).toBeNull();
  });

  it("rejects duplicate opaque bindings", () => {
    const duplicate = structuredClone(response());
    duplicate.composerConfig.knowledgeBases.push({
      ...duplicate.composerConfig.knowledgeBases[0]!
    });
    expect(decodeComposerConfigResponse(duplicate)).toBeNull();
  });
});
