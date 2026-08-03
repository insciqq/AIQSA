import { describe, expect, it } from "vitest";
import {
  attachmentBlocksFromThreadContent,
  summarizeThreadArtifacts,
  textFromPersistedContent,
  textFromThreadContent
} from "./threadContent";

describe("thread artifact summaries", () => {
  it("projects live Gemini grounding without turning provider markup into a durable artifact", () => {
    const suggestionsHtml = '<div><a href="https://www.google.com/search?q=aiqsa">AIQSA</a></div>';
    const summary = summarizeThreadArtifacts([{
      data: {
        citations: [{ title: "Source", url: "https://example.com/source" }],
        provider: "gemini",
        runSearch: { callCount: 1, queryCount: 2 },
        suggestionsHtml
      },
      type: "grounding_display"
    }]);

    expect(summary).toMatchObject({
      citationCount: 1,
      groundingDisplay: {
        callCount: 1,
        provider: "gemini",
        queryCount: 2,
        suggestionsHtml
      },
      searchActivity: [{
        displayName: "Google Search",
        providerOperations: null,
        query: null,
        sourceCount: 1,
        status: "complete"
      }],
      searchCount: 1,
      searchStrategy: "gemini-google-search"
    });
  });

  it("keeps a provider-proven search call visible when Gemini omits query metadata", () => {
    const suggestionsHtml = '<a href="https://google.com/search?q=aiqsa">Search</a>';
    expect(summarizeThreadArtifacts([{
      data: {
        citations: [],
        provider: "gemini",
        runSearch: { callCount: 1, queryCount: 0 },
        suggestionsHtml
      },
      type: "grounding_display"
    }])?.groundingDisplay).toEqual({
      callCount: 1,
      provider: "gemini",
      queryCount: 0,
      suggestionsHtml
    });
  });

  it("projects native web search artifacts into safe direct facts", () => {
    const summary = summarizeThreadArtifacts([
      {
        data: {
          artifactType: "search",
          payload: {
            action: {
              sources: [{ title: "Example", url: "https://example.com" }],
              type: "search"
            },
            id: "ws_123",
            status: "completed",
            type: "web_search_call"
          }
        },
        type: "artifact"
      }
    ]);

    expect(summary).toMatchObject({
      searchCount: 1,
      searchActivity: [{
        displayName: "Search source",
        providerOperations: [{
          kind: "search",
          queries: [],
          status: "complete"
        }],
        sourceCount: 1,
        sources: [{ title: "Example", url: "https://example.com" }],
        status: "complete"
      }],
      searchStrategy: "openai-native-web-search"
    });
    expect(JSON.stringify(summary)).not.toContain("ws_123");
  });

  it.each([
    ["cancelled", "cancelled"],
    ["error", "error"]
  ] as const)(
    "settles live running Search evidence when the run becomes %s",
    (runStatus, expectedStatus) => {
      const summary = summarizeThreadArtifacts(
        [{
          data: {
            artifactType: "search",
            payload: {
              action: { type: "search" },
              id: "ws_unresolved",
              status: "in_progress",
              type: "web_search_call"
            }
          },
          type: "artifact"
        }],
        undefined,
        [],
        runStatus
      );

      expect(summary?.searchActivity).toEqual([
        expect.objectContaining({ status: expectedStatus })
      ]);
    }
  );

  it("uses the pinned custom hosted Search identity during the live run", () => {
    const summary = summarizeThreadArtifacts([{
      data: {
        artifactType: "search",
        payload: {
          id: "ws_custom",
          status: "completed",
          type: "web_search_call"
        },
        searchDisplayName: "Company Gateway Search",
        searchStrategy: "custom-web-search:connection-1"
      },
      type: "artifact"
    }]);

    expect(summary).toMatchObject({
      searchCount: 1,
      searchActivity: [{
        displayName: "Company Gateway Search",
        providerOperations: [{ status: "complete" }],
        status: "complete"
      }],
      searchDisplayName: "Company Gateway Search",
      searchStrategy: "custom-web-search:connection-1"
    });
    expect(JSON.stringify(summary?.searchActivity)).not.toContain("ws_custom");
  });

  it("keeps a hosted Search observation visible when a historical artifact has no call shape", () => {
    const summary = summarizeThreadArtifacts([{
      data: {
        artifactType: "search",
        payload: {
          status: "complete",
          strategyId: "perplexity-tool-search"
        },
        searchDisplayName: "Perplexity Search"
      },
      type: "artifact"
    }]);

    expect(summary).toMatchObject({
      searchActivity: [],
      searchCount: 1,
      searchDisplayName: "Perplexity Search",
      searchStrategy: "perplexity-tool-search"
    });
  });

  it("prefers safe persisted Search-run facts over live call previews", () => {
    const summary = summarizeThreadArtifacts(
      [
        {
          data: {
            artifactType: "search",
            payload: {
              status: "completed",
              strategyId: "perplexity-tool-search"
            }
          },
          type: "artifact"
        }
      ],
      [
        {
          artifacts: {
            displayName: "Perplexity Search",
            providerOperations: [],
            providerOperationsTruncated: false,
            sources: [{ rank: 1, title: "Source", url: "https://example.com/source" }]
          },
          modelId: "perplexity/sonar",
          provider: "openrouter",
          query: "q",
          requestPreview: { query: "q" },
          status: "complete",
          strategyId: "perplexity-tool-search"
        }
      ]
    );

    expect(summary?.searchActivity).toEqual([
      {
        displayName: "Perplexity Search",
        providerOperations: [],
        providerOperationsTruncated: false,
        query: "q",
        sourceCount: 1,
        sources: [{ rank: 1, title: "Source", url: "https://example.com/source" }],
        status: "complete",
      }
    ]);
    expect(JSON.stringify(summary)).not.toContain("perplexity/sonar");
    expect(JSON.stringify(summary)).not.toContain("openrouter");
  });

  it("extracts reasoning summary text from provider arrays and ignores empty arrays", () => {
    const summary = summarizeThreadArtifacts([
      {
        data: {
          artifactType: "reasoning",
          payload: {
            reasoning: [{ text: "First summary", type: "summary_text" }]
          }
        },
        type: "artifact"
      },
      {
        data: {
          artifactType: "reasoning",
          payload: {
            summary: [{ text: "Second summary", type: "summary_text" }]
          }
        },
        type: "artifact"
      },
      {
        data: {
          artifactType: "reasoning",
          payload: {
            reasoning: []
          }
        },
        type: "artifact"
      }
    ]);

    expect(summary).toMatchObject({
      reasoningCount: 2,
      reasoningText: ["First summary", "Second summary"]
    });
  });

  it("surfaces the latest valid context truncation artifact as a thread hint", () => {
    expect(
      summarizeThreadArtifacts([
        {
          data: {
            artifactType: "context_truncated",
            payload: {
              approxDroppedTokens: 84,
              droppedMessages: 4
            }
          },
          type: "artifact"
        },
        {
          data: {
            artifactType: "context_truncated",
            payload: {
              approxDroppedTokens: 144,
              droppedMessages: 6
            }
          },
          type: "artifact"
        },
        {
          data: {
            artifactType: "context_truncated",
            payload: {
              approxDroppedTokens: 0,
              droppedMessages: 0
            }
          },
          type: "artifact"
        }
      ])
    ).toMatchObject({
      contextTruncation: {
        approxDroppedTokens: 144,
        droppedMessages: 6
      }
    });
  });

  it("drops unsafe citation URLs while retaining the observed citation count", () => {
    expect(
      summarizeThreadArtifacts([
        {
          data: {
            artifactType: "citation",
            payload: {
              title: "Unsafe",
              url: "javascript:alert(1)"
            }
          },
          type: "artifact"
        },
        {
          data: {
            artifactType: "citation",
            payload: {
              title: "Safe",
              url: "https://example.com/source"
            }
          },
          type: "artifact"
        }
      ])
    ).toMatchObject({
      citationCount: 2,
      citations: [
        {
          index: 2,
          title: "Safe",
          url: "https://example.com/source"
        }
      ]
    });
  });

  it("correlates live parallel tool artifacts and keeps terminal live evidence", () => {
    const toolCall = {
      data: {
        artifactType: "tool_call",
        payload: {
          argumentsPreview: { query: "memory" },
          callId: "call-1",
          ordinal: 0,
          round: 1,
          snapshot: {
            capability: "mcp",
            credentialSources: ["personal"],
            serverName: "Mem0",
            toolName: "search"
          },
          status: "requested"
        }
      },
      type: "artifact"
    };
    const summary = summarizeThreadArtifacts(
      [
        toolCall,
        {
          data: {
            artifactType: "tool_result",
            payload: {
              callId: "call-1",
              durationMs: 90,
              ordinal: 0,
              resultPreview: { content: [{ text: "found", type: "text" }] },
              round: 1,
              status: "complete"
            }
          },
          type: "artifact"
        }
      ],
      [],
      [{
        argumentsPreview: { query: "memory" },
        callId: "call-1",
        capability: "mcp",
        credentialSources: ["personal"],
        durationMs: null,
        errorMessage: null,
        externalAccountLabel: null,
        ordinal: 0,
        resultPreview: null,
        round: 1,
        serverName: "Mem0",
        status: "running",
        toolName: "search"
      }],
      "streaming"
    );

    expect(summary).toMatchObject({
      toolCallCount: 1,
      toolCalls: [{
        callId: "call-1",
        durationMs: 90,
        resultPreview: { content: [{ text: "found", type: "text" }] },
        status: "complete"
      }]
    });
  });
});

describe("thread content", () => {
  const content = {
    blocks: [
      { text: "First", type: "text" },
      { alt: "Diagram", attachmentId: "image-1", type: "image" },
      { attachmentId: "file-1", fileName: "notes.pdf", type: "file" },
      { attachmentId: "image-2", type: "image" },
      { attachmentId: "file-2", type: "file" }
    ]
  };

  it("extracts persisted text without flattening attachments", () => {
    expect(textFromPersistedContent(content)).toBe("First");
    expect(textFromThreadContent(content)).toBe("First");
    expect(textFromThreadContent("Live text")).toBe("Live text");
  });

  it("maps attachment labels with stable fallbacks", () => {
    expect(attachmentBlocksFromThreadContent(content)).toEqual([
      { attachmentId: "image-1", label: "Diagram", type: "image" },
      { attachmentId: "file-1", label: "notes.pdf", type: "file" },
      { attachmentId: "image-2", label: "Image attachment", type: "image" },
      { attachmentId: "file-2", label: "File attachment", type: "file" }
    ]);
  });
});
