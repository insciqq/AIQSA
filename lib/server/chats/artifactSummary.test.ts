import { describe, expect, it } from "vitest";
import { summarizeMessageRunArtifacts } from "./prismaRepository";

describe("summarizeMessageRunArtifacts", () => {
  it("uses native web search artifacts as expandable search details when search runs are absent", () => {
    const summary = summarizeMessageRunArtifacts({
      events: [
        {
          payload: {
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
          }
        }
      ],
      searchRuns: []
    });

    expect(summary).toMatchObject({
      searchCount: 1,
      searchDetails: [
        {
          callPreview: {
            action: {
              sources: [{ title: "Example", url: "https://example.com" }],
              type: "search"
            },
            id: "ws_123",
            status: "completed",
            type: "web_search_call"
          },
          status: "completed",
          strategyId: "openai-native-web-search"
        }
      ],
      searchStrategy: "openai-native-web-search"
    });
  });

  it("extracts reasoning summary text from provider arrays and ignores empty arrays", () => {
    const summary = summarizeMessageRunArtifacts({
      events: [
        {
          payload: {
            artifactType: "reasoning",
            payload: {
              reasoning: [{ text: "First summary", type: "summary_text" }]
            }
          }
        },
        {
          payload: {
            artifactType: "reasoning",
            payload: {
              summary: [{ text: "Second summary", type: "summary_text" }]
            }
          }
        },
        {
          payload: {
            artifactType: "reasoning",
            payload: {
              reasoning: []
            }
          }
        }
      ],
      searchRuns: []
    });

    expect(summary).toMatchObject({
      reasoningCount: 2,
      reasoningText: ["First summary", "Second summary"]
    });
  });

  it("uses the latest valid persisted context truncation artifact", () => {
    const summary = summarizeMessageRunArtifacts({
      events: [
        {
          payload: {
            artifactType: "context_truncated",
            payload: {
              approxDroppedTokens: 84,
              droppedMessages: 4
            }
          }
        },
        {
          payload: {
            artifactType: "context_truncated",
            payload: {
              approxDroppedTokens: 144,
              droppedMessages: 6
            }
          }
        },
        {
          payload: {
            artifactType: "context_truncated",
            payload: {
              approxDroppedTokens: 0,
              droppedMessages: 0
            }
          }
        }
      ],
      searchRuns: []
    });

    expect(summary).toMatchObject({
      contextTruncation: {
        approxDroppedTokens: 144,
        droppedMessages: 6
      }
    });
  });
});
