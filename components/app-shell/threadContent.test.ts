import { describe, expect, it } from "vitest";
import {
  attachmentBlocksFromThreadContent,
  summarizeThreadArtifacts,
  textFromPersistedContent,
  textFromThreadContent
} from "./threadContent";

describe("thread answer outputs", () => {
  it("projects live Gemini citations and required suggestions without run counters", () => {
    const suggestionsHtml =
      '<div><a href="https://www.google.com/search?q=aiqsa">AIQSA</a></div>';
    const summary = summarizeThreadArtifacts([{
      data: {
        citations: [{ title: "Source", url: "https://example.com/source" }],
        provider: "gemini",
        runSearch: { callCount: 1, queryCount: 2 },
        suggestionsHtml
      },
      type: "grounding_display"
    }]);

    expect(summary).toEqual({
      citations: [{
        index: 1,
        title: "Source",
        url: "https://example.com/source"
      }],
      groundingDisplay: {
        provider: "gemini",
        suggestionsHtml
      },
      reasoningText: [],
      sources: [{
        rank: 1,
        title: "Source",
        url: "https://example.com/source"
      }]
    });
    expect(summary?.groundingDisplay).not.toHaveProperty("callCount");
    expect(summary?.groundingDisplay).not.toHaveProperty("queryCount");
  });

  it("keeps only normalized Sources from live Search data", () => {
    const summary = summarizeThreadArtifacts([{
        data: {
          artifactType: "search",
          payload: {
            action: {
              query: "private live query",
              sources: [{
                snippet: "Live result",
                title: "Live source",
                url: "https://example.com/live"
              }],
              type: "search"
            },
            id: "private-call-id",
            status: "completed",
            type: "web_search_call"
          }
        },
        type: "artifact"
      }]);

    expect(summary).toEqual({
      citations: [],
      groundingDisplay: null,
      reasoningText: [],
      sources: [{
        rank: 1,
        snippet: "Live result",
        title: "Live source",
        url: "https://example.com/live"
      }]
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /private live query|private-call-id/
    );
  });

  it("projects safe citations and Reasoning while dropping unsafe links", () => {
    const summary = summarizeThreadArtifacts([
      {
        data: {
          artifactType: "citation",
          payload: { title: "Unsafe", url: "javascript:alert(1)" }
        },
        type: "artifact"
      },
      {
        data: {
          artifactType: "citation",
          payload: { title: "Safe", url: "https://example.com/source" }
        },
        type: "artifact"
      },
      {
        data: {
          artifactType: "reasoning",
          payload: {
            reasoning: [{ text: "Checked the direct sources.", type: "summary_text" }]
          }
        },
        type: "artifact"
      }
    ]);

    expect(summary).toEqual({
      citations: [{
        index: 2,
        title: "Safe",
        url: "https://example.com/source"
      }],
      groundingDisplay: null,
      reasoningText: ["Checked the direct sources."],
      sources: []
    });
  });

  it("does not turn context or settled tool artifacts into answer output", () => {
    expect(summarizeThreadArtifacts([
      {
        data: {
          artifactType: "context_truncated",
          payload: { approxDroppedTokens: 84, droppedMessages: 4 }
        },
        type: "artifact"
      },
      {
        data: {
          artifactType: "tool_result",
          payload: {
            callId: "private-call",
            resultPreview: { private: true },
            status: "complete"
          }
        },
        type: "artifact"
      }
    ])).toBeNull();
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
