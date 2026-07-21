import { describe, expect, it } from "vitest";
import {
  attachmentBlocksFromThreadContent,
  summarizeThreadArtifacts,
  textFromPersistedContent,
  textFromThreadContent
} from "./threadContent";

describe("thread artifact summaries", () => {
  it("uses native web search artifacts as details when search runs are absent", () => {
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

  it("prefers persisted search-run previews over live call previews", () => {
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
          artifacts: { finalProviderResponsePreview: { answer: "preview" } },
          modelId: "perplexity/sonar",
          provider: "openrouter",
          requestPreview: { query: "q" },
          status: "complete",
          strategyId: "perplexity-tool-search"
        }
      ]
    );

    expect(summary?.searchDetails).toEqual([
      {
        modelId: "perplexity/sonar",
        provider: "openrouter",
        requestPreview: { query: "q" },
        responsePreview: { answer: "preview" },
        status: "complete",
        strategyId: "perplexity-tool-search"
      }
    ]);
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
