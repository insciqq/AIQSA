import { describe, expect, it } from "vitest";
import {
  attachmentBlocksFromThreadContent,
  summarizeThreadArtifacts,
  mergeLiveThreadArtifacts,
  textFromPersistedContent,
  textFromThreadContent
} from "./threadContent";
import { makeContextCompactionStatus } from "@/lib/contracts/contextCompaction";

describe("thread answer outputs", () => {
  it("projects live Gemini citations and required suggestions without run counters", () => {
    const suggestionsHtml =
      '<div><a href="https://www.google.com/search?q=aiqsa">AIQSA</a></div>';
    const summary = summarizeThreadArtifacts([{
      data: {
        citations: [{ startIndex: 0, endIndex: 8, title: "Source", url: "https://example.com/source" }],
        provider: "gemini",
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

  it("keeps the persisted compaction outcome after late progress", () => {
    const status = (state: "running" | "complete", outcome: "pending" | "summary_applied") => ({
      data: {
        artifactType: "context_compaction",
        payload: makeContextCompactionStatus({
          afterTokens: 600, beforeTokens: 1_200, outcome, state
        })
      },
      type: "artifact"
    });
    const summary = summarizeThreadArtifacts([status("running", "pending"), status("complete", "summary_applied"), status("running", "pending")]);
    expect(summary?.contextCompaction).toMatchObject({ state: "complete", outcome: "summary_applied", reducedTokens: 600 });
    expect(JSON.stringify(summary)).not.toContain("pending");
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


it("keeps exact checkpoint downloads through round reset and failure without merging equal names", () => {
  const checkpoint = { id: "cp-1", description: "First version", createdAt: "2026-09-24T09:00:00.000Z" };
  const file = { attachmentId: "draft-1", byteSize: 7, fileName: "result.psd", mimeType: "application/octet-stream", relativePath: "result.psd", checkpoint };
  const second = { ...file, attachmentId: "draft-2", checkpoint: { ...checkpoint, id: "cp-2", description: "Second version" } };
  const event = (f: typeof file) => ({ type: "artifact", data: { artifactType: "workspace_checkpoint", payload: { checkpoint: f.checkpoint, files: [f] } } });
  const summary = summarizeThreadArtifacts([event(file), { type: "message_reset", data: { round: 2 } }, event(second), event(file),
    event({ ...file, fileName: "replacement.psd" }), { type: "error", data: { code: "provider_request_timed_out" } }]);
  expect(summary?.generatedFiles).toEqual([file, second]);
  expect(summarizeThreadArtifacts([{ ...event(file), data: { artifactType: "workspace_checkpoint", payload: { checkpoint, files: [{ ...file, checkpoint: null }] } } }])).toBeNull();
  const saved = { citations: [], reasoningText: [], sources: [], generatedFiles: [file] };
  expect(mergeLiveThreadArtifacts(saved, summary)?.generatedFiles).toEqual([file, second]);
  expect(mergeLiveThreadArtifacts(saved, { citations: [], reasoningText: ["Still working"], sources: [] })?.generatedFiles).toEqual([file]);
  expect(mergeLiveThreadArtifacts(saved, null)).toEqual(saved);
  const running = { citations: [], reasoningText: [], sources: [], contextCompaction: makeContextCompactionStatus({
    afterTokens: 600, beforeTokens: 1_200, outcome: "pending", state: "running"
  }) };
  const complete = { ...saved, contextCompaction: makeContextCompactionStatus({
    afterTokens: 600, beforeTokens: 1_200, outcome: "summary_applied", state: "complete"
  }) };
  expect(mergeLiveThreadArtifacts(complete, running)?.contextCompaction?.state).toBe("complete");
  expect(mergeLiveThreadArtifacts(running, complete)?.contextCompaction?.state).toBe("complete");
  expect(mergeLiveThreadArtifacts(running, null)?.contextCompaction?.state).toBe("running");
});

it("keeps saved citations, sources, reasoning and grounding when the live summary carries only compaction", () => {
  const saved = {
    citations: [{ index: 1, title: "Saved source", url: "https://example.com/saved" }],
    groundingDisplay: { provider: "gemini" as const, suggestionsHtml: "<div>Saved suggestions</div>" },
    reasoningText: ["Saved reasoning"],
    sources: [{ rank: 1, title: "Saved search result", url: "https://example.com/result" }],
    workDurationMs: 8_300
  };
  const live = summarizeThreadArtifacts([{
    data: {
      artifactType: "context_compaction",
      payload: makeContextCompactionStatus({ afterTokens: 600, beforeTokens: 1_200, outcome: "summary_applied", state: "complete" })
    },
    type: "artifact"
  }]);
  expect(live).toMatchObject({ citations: [], groundingDisplay: null, reasoningText: [], sources: [] });
  const merged = mergeLiveThreadArtifacts(saved, live);
  expect(merged).toMatchObject({
    citations: saved.citations,
    groundingDisplay: saved.groundingDisplay,
    reasoningText: saved.reasoningText,
    sources: saved.sources,
    workDurationMs: 8_300
  });
  expect(merged?.contextCompaction).toMatchObject({ outcome: "summary_applied", state: "complete" });
  expect(mergeLiveThreadArtifacts({ ...saved, groundingDisplay: undefined }, live)?.groundingDisplay).toBeNull();
  expect(mergeLiveThreadArtifacts(saved, { ...live!, reasoningText: ["Live reasoning"] })?.reasoningText)
    .toEqual(["Live reasoning"]);
});
