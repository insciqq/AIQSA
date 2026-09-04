import { describe, expect, it } from "vitest";
import {
  summarizeMessageRunArtifacts,
  summarizeMessageRunToolActivity
} from "./prismaRepository";
import { namespacedWorkspaceToolName } from "../workspace/toolCatalog";

describe("summarizeMessageRunArtifacts", () => {
  it("projects only the friendly Memory availability state", () => {
    const summary = summarizeMessageRunArtifacts(
      { events: [], searchRuns: [] },
      undefined,
      null,
      [],
      "UNAVAILABLE"
    );

    expect(summary).toEqual({
      citations: [],
      knowledgeCitations: [],
      memoryStatus: "UNAVAILABLE",
      reasoningText: [],
      sources: []
    });
    expect(summary).not.toHaveProperty("degradationCode");
    expect(summary).not.toHaveProperty("outcome");
  });

  it("projects limited Memory use without exposing its internal degradation reason", () => {
    const summary = summarizeMessageRunArtifacts(
      { events: [], searchRuns: [] },
      undefined,
      null,
      [],
      "LIMITED"
    );

    expect(summary).toMatchObject({ memoryStatus: "LIMITED" });
    expect(summary).not.toHaveProperty("degradationCode");
    expect(summary).not.toHaveProperty("outcome");
  });

  it("projects only direct citations, Sources, and Reasoning", () => {
    const summary = summarizeMessageRunArtifacts({
      events: [
        {
          payload: {
            artifactType: "citation",
            payload: {
              routeId: "private-route",
              title: "Citation",
              url: "https://example.com/citation"
            }
          }
        },
        {
          payload: {
            artifactType: "reasoning",
            payload: { summary: "Compared the direct sources." }
          }
        },
        {
          payload: {
            artifactType: "search",
            payload: {
              action: {
                query: "private generated query",
                sources: [{
                  description: "Safe hosted snippet",
                  title: "Hosted source",
                  url: "https://example.com/hosted"
                }]
              },
              id: "private-provider-call"
            }
          }
        },
        {
          payload: {
            artifactType: "tool_result",
            payload: { resultPreview: { secret: true } }
          }
        },
        {
          payload: {
            artifactType: "context_truncated",
            payload: { approxDroppedTokens: 100, droppedMessages: 2 }
          }
        }
      ],
      searchRuns: [{
        artifacts: {
          providerOperations: [{ queries: ["private persisted query"] }],
          sources: [{
            rank: 4,
            snippet: "Safe persisted snippet",
            title: "Persisted source",
            url: "https://example.com/persisted"
          }]
        }
      }]
    });

    expect(summary).toEqual({
      citations: [{
        index: 1,
        title: "Citation",
        url: "https://example.com/citation"
      }],
      knowledgeCitations: [],
      reasoningText: ["Compared the direct sources."],
      sources: [
        {
          rank: 1,
          snippet: "Safe persisted snippet",
          title: "Persisted source",
          url: "https://example.com/persisted"
        },
        {
          rank: 2,
          snippet: "Safe hosted snippet",
          title: "Hosted source",
          url: "https://example.com/hosted"
        }
      ]
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /private-route|private generated query|private-provider-call|private persisted query|tool_result|context_truncated/
    );
  });

  it("projects only cited legacy Knowledge handles without stale source labels", () => {
    const summary = summarizeMessageRunArtifacts({
      events: [],
      knowledgeRuns: [{
        invocationOrdinal: 12,
        results: [
          {
            baseName: "Policies",
            documentVersionNumber: 3,
            fileName: "handbook.pdf",
            handle: "K12.1",
            includedText: "private-passage-sentinel",
            knowledgeBaseId: "private-base-id",
            locator: "private-source-locator-sentinel",
            page: 12,
            provenance: [{
              source: {
                artifactId: "private-source-artifact-id-sentinel",
                bindings: [
                  { baseName: "Policies", bindingOrdinal: 0, knowledgeBaseId: "private-base-id" },
                  {
                    baseName: "Mirror",
                    bindingOrdinal: 1,
                    knowledgeBaseId: "private-secondary-base-id-sentinel"
                  }
                ],
                primaryBindingOrdinal: 0,
                sourceId: "private-source-id-sentinel",
                sourceVersionId: "private-source-version-id-sentinel"
              }
            }],
            sourceArtifactId: "private-source-artifact-id-sentinel",
            sourceId: "private-source-id-sentinel",
            sourceVersionId: "private-source-version-id-sentinel"
          },
          {
            baseName: "Policies",
            fileName: "unused.pdf",
            handle: "K12.2",
            includedText: "unused-private-passage",
            knowledgeBaseId: "private-base-id",
            page: 4
          }
        ]
      }],
      searchRuns: []
    }, {
      blocks: [{ text: "The policy applies [K12.1].", type: "text" }]
    });

    expect(summary).toEqual({
      citations: [],
      knowledgeCitations: [{
        handle: "K12.1"
      }],
      reasoningText: [],
      sources: []
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /private-passage-sentinel|handbook\.pdf|unused\.pdf|Policies|private-base-id|documentVersionNumber|private-source-locator-sentinel|private-secondary-base-id-sentinel|private-source-artifact-id-sentinel|private-source-id-sentinel|private-source-version-id-sentinel/
    );
  });

  it("prefers v2 receipt handles and preserves only deletion state", () => {
    const summary = summarizeMessageRunArtifacts({
      events: [],
      knowledgeRetrievalSession: {
        evidenceItems: [
          Object.assign({ handle: "K1", state: "available" }, {
            provenance: [{
              source: {
                artifactId: "private-v2-source-artifact-id-sentinel",
                bindings: [
                  { baseName: "Primary", bindingOrdinal: 0, knowledgeBaseId: "private-primary" },
                  {
                    baseName: "Mirror",
                    bindingOrdinal: 1,
                    knowledgeBaseId: "private-v2-secondary-base-id-sentinel"
                  }
                ],
                primaryBindingOrdinal: 0,
                sourceId: "private-v2-source-id-sentinel",
                sourceVersionId: "private-v2-source-version-id-sentinel"
              }
            }],
            sourceArtifactId: "private-v2-source-artifact-id-sentinel",
            sourceId: "private-v2-source-id-sentinel",
            sourceVersionId: "private-v2-source-version-id-sentinel"
          }),
          { handle: "K2", state: "deleted" },
          { handle: "K3", state: "available" }
        ]
      },
      knowledgeRuns: [Object.assign({
        invocationOrdinal: 1,
        results: [{ handle: "K1.1", fileName: "legacy-must-not-project.pdf" }]
      }, {
        readReceipt: {
          locator: "private-v2-read-locator-sentinel",
          resolvedSource: {
            sourceArtifactId: "private-v2-source-artifact-id-sentinel",
            sourceId: "private-v2-source-id-sentinel",
            sourceVersionId: "private-v2-source-version-id-sentinel"
          }
        }
      })],
      searchRuns: []
    }, {
      blocks: [{ text: "Supported [K1], removed [K2], but not unused K3.", type: "text" }]
    });

    expect(summary?.knowledgeCitations).toEqual([
      { handle: "K1" },
      { deleted: true, handle: "K2" }
    ]);
    expect(JSON.stringify(summary)).not.toMatch(
      /legacy-must-not-project\.pdf|private-v2-secondary-base-id-sentinel|private-v2-source-artifact-id-sentinel|private-v2-source-id-sentinel|private-v2-source-version-id-sentinel|private-v2-read-locator-sentinel/
    );
  });

  it("projects only the completed Knowledge answer and readiness state", () => {
    const summary = summarizeMessageRunArtifacts({
      events: [],
      knowledgeRetrievalSession: {
        degradedFlags: ["partial_readiness", "private-internal-diagnostic"],
        evidenceItems: [],
        groundingResult: { outcome: "no_answer" }
      },
      knowledgeRuns: [],
      searchRuns: []
    });

    expect(summary).toEqual({
      citations: [],
      knowledgeCitations: [],
      knowledgeState: {
        answer: "insufficient_evidence",
        scope: "partial_sources_ready"
      },
      reasoningText: [],
      sources: []
    });
    expect(JSON.stringify(summary)).not.toContain("private-internal-diagnostic");
  });

  it("keeps only a committed Memory action", () => {
    const action = { operation: "UPDATE" as const, status: "COMMITTED" as const };
    const withAction = summarizeMessageRunArtifacts(
      { events: [], searchRuns: [] },
      undefined,
      action
    );
    const withoutAction = summarizeMessageRunArtifacts(
      { events: [], searchRuns: [] },
      undefined,
      null
    );

    expect(withAction).toEqual({
      citations: [],
      knowledgeCitations: [],
      memoryAction: action,
      reasoningText: [],
      sources: []
    });
    expect(withoutAction).toBeNull();
  });

  it("returns no artifact for execution-only records", () => {
    const run = {
      events: [{
        payload: {
          artifactType: "tool_result",
          payload: {
            argumentsPreview: { private: true },
            resultPreview: { private: true }
          }
        }
      }],
      normalizedRequest: { private: true },
      searchRuns: [],
      status: "complete",
      toolCalls: [{ result: { private: true } }]
    };

    expect(summarizeMessageRunArtifacts(run)).toBeNull();
  });
});

describe("summarizeMessageRunToolActivity", () => {
  it("projects automatic Knowledge preflight as the first user-facing round", () => {
    expect(summarizeMessageRunToolActivity({
      errorPayload: null,
      normalizedRequest: {},
      status: "complete",
      toolCalls: [{
        completedAt: new Date("2026-08-17T00:00:00.120Z"),
        ordinal: 0,
        roundIndex: 0,
        startedAt: new Date("2026-08-17T00:00:00.000Z"),
        state: "complete",
        toolName: "retrieve_knowledge"
      }]
    })).toEqual({
      calls: [{
        durationMs: 120,
        round: 1,
        serverName: "Knowledge",
        status: "complete",
        toolName: "search_knowledge"
      }]
    });
  });

  it("projects ordered safe labels, status, duration, and an exhausted round warning", () => {
    const activity = summarizeMessageRunToolActivity({
      errorPayload: null,
      normalizedRequest: {
        mcp: {
          tools: [{
            namespacedName: "mcp_aws_search_123",
            originalName: "search_documentation",
            serverName: "AWS Documentation"
          }]
        },
        toolBudgets: { maxToolCalls: 20, maxToolRounds: 1 }
      },
      status: "complete",
      toolCalls: [
        {
          completedAt: new Date("2026-08-17T00:00:00.120Z"),
          ordinal: 0,
          roundIndex: 1,
          startedAt: new Date("2026-08-17T00:00:00.000Z"),
          state: "complete",
          toolName: "find_tools"
        },
        {
          completedAt: new Date("2026-08-17T00:00:00.500Z"),
          ordinal: 1,
          roundIndex: 1,
          startedAt: new Date("2026-08-17T00:00:00.200Z"),
          state: "error",
          toolName: "mcp_aws_search_123"
        }
      ]
    });

    expect(activity).toEqual({
      calls: [
        {
          durationMs: 120,
          round: 1,
          serverName: "Auto tools",
          status: "complete",
          toolName: "find_tools"
        },
        {
          durationMs: 300,
          round: 1,
          serverName: "AWS Documentation",
          status: "error",
          toolName: "search_documentation"
        }
      ],
      warning: { kind: "rounds", limit: 1 }
    });
    expect(JSON.stringify(activity)).not.toMatch(/arguments|result|namespacedName|mcp_aws/iu);
  });

  it("retains a call-limit warning when the rejected batch was not persisted", () => {
    expect(summarizeMessageRunToolActivity({
      errorPayload: { code: "tool_call_limit_exceeded" },
      normalizedRequest: { toolBudgets: { maxToolCalls: 20, maxToolRounds: 8 } },
      status: "error",
      toolCalls: []
    })).toEqual({
      calls: [],
      warning: { kind: "calls", limit: 20 }
    });
  });

  it("never falls back to an internal MCP namespace", () => {
    expect(summarizeMessageRunToolActivity({
      errorPayload: null,
      normalizedRequest: {},
      status: "complete",
      toolCalls: [{
        completedAt: null,
        ordinal: 0,
        roundIndex: 1,
        startedAt: null,
        state: "running",
        toolName: "mcp_private_internal_tool_0123456789"
      }]
    })?.calls[0]?.toolName).toBe("MCP tool");
  });

  it("projects canonical Workspace tools with a safe user-facing owner", () => {
    expect(summarizeMessageRunToolActivity({
      errorPayload: null,
      normalizedRequest: { workspace: { enabled: true } },
      status: "complete",
      toolCalls: [{
        completedAt: null,
        ordinal: 0,
        roundIndex: 1,
        startedAt: null,
        state: "complete",
        toolName: namespacedWorkspaceToolName("sandbox_fs_read")
      }]
    })?.calls[0]).toMatchObject({
      serverName: "Workspace",
      toolName: "sandbox_fs_read"
    });
  });
});
