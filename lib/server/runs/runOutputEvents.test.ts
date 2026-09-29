import { describe, expect, it } from "vitest";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import type { SessionContextStatus } from "../../contracts/sessionStatus";
import { makeContextCompactionStatus } from "../../contracts/contextCompaction";
import { GROUNDING_DISPLAY_MAX_CITATIONS } from "../../domain/groundingDisplay";
import { REASONING_RECORD_MAX_CHARACTERS } from "../../domain/answerReasoning";
import {
  isRunOutputArtifactEvent,
  projectRunOutputArtifactEvent,
  runOutputArtifactEvents
} from "./runOutputEvents";

it("accepts a server-owned context snapshot for persistence but rejects provider-supplied snapshots", () => {
  const payload: SessionContextStatus = {
    approximateInputTokens: 44, contextWindow: 1000, droppedMessages: 0, loadedTools: 1,
    maxOutputTokens: 100, modelId: "model", phase: "after_answer", provider: "fake", safetyMarginTokens: 100, version: 1
  };
  const event = { type: "artifact", data: { artifactType: "context_status", payload } } as const;
  expect(isRunOutputArtifactEvent(event)).toBe(true);
  expect(projectRunOutputArtifactEvent(event)).toBeNull();
  expect(isRunOutputArtifactEvent({ ...event, data: { ...event.data, payload: { ...payload, rawRequest: "private" } } })).toBe(false);
});

it("accepts only the content-free server compaction status at the durable event boundary", () => {
  const payload = makeContextCompactionStatus({
    afterTokens: 600, beforeTokens: 1_200, outcome: "summary_applied", state: "complete"
  });
  const event = { type: "artifact", data: { artifactType: "context_compaction", payload } } as const;
  expect(isRunOutputArtifactEvent(event)).toBe(true);
  expect(projectRunOutputArtifactEvent(event)).toBeNull();
  expect(isRunOutputArtifactEvent({ ...event, data: { ...event.data, payload: { ...payload, notes: "private" } } })).toBe(false);
  expect(JSON.stringify(payload)).not.toMatch(/notes|sourceRefs|prompt|provider/iu);
});

it("persists only bounded absolute per-engine search counters", () => {
  const event = { type: "artifact", data: { artifactType: "search_activity", payload: {
    engines: [{ engine: 1, name: "Perplexity", requested: 2, settled: 1,
      complete: 1, error: 0, skipped: 0 }]
  } } } as const;
  expect(projectRunOutputArtifactEvent(event)).toEqual(event);
  expect(isRunOutputArtifactEvent(event)).toBe(true);
  const privateEvent = { ...event, data: { ...event.data, payload: { engines: [
    { ...event.data.payload.engines[0]!, invocationId: "private" }
  ] } } };
  expect(projectRunOutputArtifactEvent(privateEvent)).toBeNull();
  expect(isRunOutputArtifactEvent(privateEvent)).toBe(false);
});

describe("durable run output events", () => {
  it("keeps only validated grounding display and strips provider counters, styles and wrappers", () => {
    const event = { type: "grounding_display" as const, data: {
      provider: "gemini" as const,
      suggestionsHtml: '<style>div{color:red}</style><div><a href="https://www.google.com/search?q=weather">Weather</a></div>',
      citations: [{ startIndex: 0, endIndex: 8, title: "Source", url: "https://example.test/source",
        thoughtSignature: "private-signature" }],
      runSearch: { callCount: 1, queryCount: 1 }, queries: ["private generated query"],
      operationId: "private-operation", raw: { upstream: true }
    } };
    const projected = projectRunOutputArtifactEvent(event);
    expect(projected).toEqual({ type: "grounding_display", data: {
      provider: "gemini",
      suggestionsHtml: '<div><a href="https://www.google.com/search?q=weather">Weather</a></div>',
      citations: [{ startIndex: 0, endIndex: 8, title: "Source", url: "https://example.test/source" }]
    } });
    expect(isRunOutputArtifactEvent(event)).toBe(false);
    expect(projected && isRunOutputArtifactEvent(projected)).toBe(true);
    expect(JSON.stringify(projected)).not.toMatch(/private|runSearch|queries|style|upstream|operationId/);
  });

  it.each([
    { suggestionsHtml: "" },
    { suggestionsHtml: '<a href="javascript:alert(1)">Unsafe</a>' },
    { suggestionsHtml: '<a href="https://www.google.com/search?q=x" onclick="alert(1)">Unsafe</a>' },
    { suggestionsHtml: "x".repeat(256 * 1_024 + 1) },
    { citations: [{ startIndex: 0, endIndex: -1, title: "Invalid", url: "https://example.test" }] },
    { citations: [{ startIndex: 0, endIndex: 1, title: "Invalid", url: "javascript:alert(1)" }] },
    { citations: [{ startIndex: 0, endIndex: 1, title: "Invalid", url: "https://user:secret@example.test" }] },
    { citations: Array.from({ length: GROUNDING_DISPLAY_MAX_CITATIONS + 1 }, () => ({
      startIndex: 0, endIndex: 1, title: "Source", url: "https://example.test"
    })) }
  ])("rejects unsafe or over-budget grounding display %#", (invalid) => {
    expect(projectRunOutputArtifactEvent({ type: "grounding_display", data: {
      provider: "gemini", citations: [],
      suggestionsHtml: '<a href="https://www.google.com/search?q=x">Search</a>', ...invalid
    } })).toBeNull();
  });

  it("projects citations and reasoning into output-only shapes", () => {
    const citation = projectRunOutputArtifactEvent({
      data: {
        artifactType: "citation",
        payload: {
          index: 3,
          providerCallId: "private-call-id",
          routeId: "private-route",
          snippet: " A bounded excerpt. ",
          source: " Hosted Search ",
          title: " Source title ",
          type: "url_citation",
          url: "https://example.com/source"
        }
      },
      type: "artifact"
    });
    const reasoning = projectRunOutputArtifactEvent({
      data: {
        artifactType: "reasoning",
        payload: {
          id: "private-reasoning-id",
          summary: [
            { text: "Compared the sources.", type: "summary_text" },
            { text: "Checked the conclusion.", type: "summary_text" }
          ],
          type: "reasoning"
        }
      },
      type: "artifact"
    });

    expect(citation).toEqual({
      data: {
        artifactType: "citation",
        payload: {
          index: 3,
          snippet: "A bounded excerpt.",
          source: "Hosted Search",
          title: "Source title",
          url: "https://example.com/source"
        }
      },
      type: "artifact"
    });
    expect(reasoning).toEqual({
      data: {
        artifactType: "reasoning",
        payload: { entry: "start", text: "Compared the sources.\n\nChecked the conclusion." }
      },
      type: "artifact"
    });
    expect(JSON.stringify([citation, reasoning])).not.toMatch(
      /private-call-id|private-route|private-reasoning-id|summary_text|url_citation/
    );
    expect(citation && isRunOutputArtifactEvent(citation)).toBe(true);
    expect(reasoning && isRunOutputArtifactEvent(reasoning)).toBe(true);
  });

  it("projects a bounded generated artifact receipt without exposing bundle contents", () => {
    const raw: ModelRunSseEvent = {
      type: "artifact",
      data: {
        artifactType: "generated_artifact",
        payload: {
          artifact_id: "artifact-1",
          entrypoint: "index.html",
          kind: "game",
          title: "Tiny game",
          version_id: "version-1",
          version_number: 1,
          privateBundle: "should not cross the boundary"
        }
      }
    };
    const projected = projectRunOutputArtifactEvent(raw);
    expect(projected).toEqual({ type: "artifact", data: { artifactType: "generated_artifact", payload: {
      artifactId: "artifact-1", entrypoint: "index.html", kind: "game", title: "Tiny game", versionId: "version-1", versionNumber: 1
    } } });
    expect(projected && isRunOutputArtifactEvent(projected)).toBe(true);
    expect(JSON.stringify(projected)).not.toContain("privateBundle");
  });

  it("retains only normalized safe sources from hosted-search events", () => {
    const rawEvent: ModelRunSseEvent = {
      data: {
        artifactType: "search",
        payload: {
          action: {
            query: "private generated query",
            sources: [
              {
                description: "Safe source summary",
                providerMetadata: "private-source-metadata",
                title: "Hosted source",
                url: "https://example.com/hosted"
              },
              { title: "Unsafe source", url: "javascript:alert(1)" }
            ],
            type: "search"
          },
          id: "private-provider-call",
          responseId: "private-response-id",
          status: "completed",
          type: "web_search_call"
        }
      },
      type: "artifact"
    };

    const output = projectRunOutputArtifactEvent(rawEvent);

    expect(output).toEqual({
      data: {
        artifactType: "search",
        payload: {
          action: {
            sources: [{
              rank: 1,
              snippet: "Safe source summary",
              title: "Hosted source",
              url: "https://example.com/hosted"
            }]
          }
        }
      },
      type: "artifact"
    });
    expect(output && isRunOutputArtifactEvent(output)).toBe(true);
    expect(isRunOutputArtifactEvent(rawEvent)).toBe(false);
    expect(JSON.stringify(output)).not.toMatch(
      /private generated query|private-source-metadata|private-provider-call|private-response-id|javascript:/
    );
  });

  it("drops lifecycle, query-only Search, and opaque reasoning artifacts", () => {
    expect(runOutputArtifactEvents([
      { data: { delta: "answer" }, type: "token" },
      {
        data: {
          artifactType: "search",
          payload: { action: { query: "private query" }, id: "search-1" }
        },
        type: "artifact"
      },
      {
        data: {
          artifactType: "reasoning",
          payload: { encryptedContent: "private reasoning state", id: "reasoning-1" }
        },
        type: "artifact"
      },
      {
        data: { artifactType: "tool_result", payload: { private: true } },
        type: "artifact"
      }
    ])).toEqual([]);
  });

  it("drops private Knowledge read receipts, Source identities, and Base provenance", () => {
    const privateKnowledgeArtifact: ModelRunSseEvent = {
      data: {
        artifactType: "tool_result",
        payload: {
          canonicalSourceProvenance: [{
            artifactId: "private-source-artifact-id-sentinel",
            bindings: [
              { baseName: "Primary", bindingOrdinal: 0, knowledgeBaseId: "primary-base" },
              {
                baseName: "Mirror",
                bindingOrdinal: 1,
                knowledgeBaseId: "private-secondary-base-id-sentinel"
              }
            ],
            primaryBindingOrdinal: 0,
            sourceId: "private-source-id-sentinel",
            sourceVersionId: "private-source-version-id-sentinel"
          }],
          readReceipt: {
            locator: "private-source-locator-sentinel",
            resolvedSource: {
              sourceArtifactId: "private-source-artifact-id-sentinel",
              sourceId: "private-source-id-sentinel",
              sourceVersionId: "private-source-version-id-sentinel"
            }
          }
        }
      },
      type: "artifact"
    };

    expect(projectRunOutputArtifactEvent(privateKnowledgeArtifact)).toBeNull();
    expect(runOutputArtifactEvents([privateKnowledgeArtifact])).toEqual([]);
  });
});


describe("write projection and durable boundary agree", () => {
  const artifact = (artifactType: "citation" | "reasoning" | "search", payload: unknown): ModelRunSseEvent =>
    ({ data: { artifactType, payload }, type: "artifact" });
  const durable = (event: ModelRunSseEvent) => {
    const projected = projectRunOutputArtifactEvent(event);
    expect(projected).not.toBeNull();
    expect(isRunOutputArtifactEvent(projected!)).toBe(true);
    expect(projectRunOutputArtifactEvent(projected!)).toEqual(projected);
    return projected!;
  };

  it("keeps a bare provider source with a long URL instead of failing the answer", () => {
    const longUrl = `https://example.com/${"a".repeat(600)}`;
    const tooLong = `https://example.com/${"b".repeat(2_100)}`;
    const projected = durable(artifact("search", { action: { sources: [
      { type: "url", url: longUrl },
      { title: "Too long to link", url: tooLong },
      { title: `  ${"t".repeat(499)}😀tail`, url: "https://example.org/emoji" }
    ] } }));
    expect(projected.data).toEqual({ artifactType: "search", payload: { action: { sources: [
      { rank: 1, title: "example.com", url: longUrl },
      { rank: 2, title: "example.org", url: "https://example.org/emoji" }
    ] } } });
  });

  it("cuts citation text at a code point and never leaves a trailing space the boundary rejects", () => {
    const projected = durable(artifact("citation", {
      snippet: `${"s".repeat(1_999)} tail`,
      source: "x".repeat(199) + "😀",
      title: `${"a".repeat(499)} rest`,
      url: "https://example.com/cited"
    }));
    expect(projected.data).toEqual({ artifactType: "citation", payload: {
      index: 1,
      snippet: "s".repeat(1_999),
      source: "x".repeat(199),
      title: "a".repeat(499),
      url: "https://example.com/cited"
    } });
    expect(projectRunOutputArtifactEvent(artifact("citation", {
      title: "Too long", url: `https://example.com/${"c".repeat(2_100)}`
    }))).toBeNull();
  });

  it("stores merged thinking fragments exactly and marks what a record could not hold", () => {
    expect(durable(artifact("reasoning", { entry: "start", text: "Let me " })).data)
      .toEqual({ artifactType: "reasoning", payload: { entry: "start", text: "Let me " } });
    expect(durable(artifact("reasoning", { entry: "continue", text: "\n\n" })).data)
      .toEqual({ artifactType: "reasoning", payload: { entry: "continue", text: "\n\n" } });
    expect(projectRunOutputArtifactEvent(artifact("reasoning", { entry: "start", text: "  " }))).toBeNull();
    expect(durable(artifact("reasoning", { entry: "start", text: "a\u0000b\uD83D" })).data)
      .toEqual({ artifactType: "reasoning", payload: { entry: "start", text: "ab�" } });

    const chunk = `${"x".repeat(REASONING_RECORD_MAX_CHARACTERS - 1)}😀 and more`;
    const big = durable(artifact("reasoning", { reasoning: chunk }));
    expect(big.data).toEqual({ artifactType: "reasoning", payload: {
      entry: "start", text: "x".repeat(REASONING_RECORD_MAX_CHARACTERS - 1), truncated: true
    } });

    const summary = Array.from({ length: 250 }, (_, index) => ({ text: `Step ${index + 1}.`, type: "summary_text" }));
    const whole = durable(artifact("reasoning", { id: "private-id", summary, type: "reasoning" }));
    expect(whole.data).toEqual({ artifactType: "reasoning", payload: {
      entry: "start", text: summary.map(({ text }) => text).join("\n\n")
    } });
    const tooMany = durable(artifact("reasoning", { summary: Array.from({ length: 6_000 }, () => ({ text: "Part." })) }));
    expect(tooMany.data).toMatchObject({ payload: { entry: "start", truncated: true } });
    expect(JSON.stringify([whole, tooMany])).not.toContain("private-id");
  });

  it("rejects pre-merge and non-exact reasoning records at the durable boundary", () => {
    for (const payload of [
      { text: "Legacy row" },
      { entry: "start", text: "Wrapped", id: "private" },
      { entry: "middle", text: "Unknown entry" },
      { entry: "start", text: "Flag", truncated: false },
      { entry: "start", text: "a\u0000b" },
      { entry: "start", text: "x".repeat(REASONING_RECORD_MAX_CHARACTERS + 1) }
    ]) {
      expect(isRunOutputArtifactEvent({ data: { artifactType: "reasoning", payload }, type: "artifact" })).toBe(false);
    }
  });
});

it("persists only an exact safe checkpoint publication and rejects private or mixed references", () => {
  const checkpoint = { id: "checkpoint-1", description: "Saved layout", createdAt: "2026-09-24T09:00:00.000Z" };
  const file = { attachmentId: "draft-1", byteSize: 9, fileName: "layout.psd", mimeType: "application/octet-stream", relativePath: "layout.psd", checkpoint };
  const event = { type: "artifact", data: { artifactType: "workspace_checkpoint", payload: { checkpoint, files: [file] } } } as const;
  expect(projectRunOutputArtifactEvent(event)).toEqual(event);
  expect(isRunOutputArtifactEvent(event)).toBe(true);
  for (const payload of [{ ...event.data.payload, captureId: "private" },
    { checkpoint, files: [{ ...file, objectKey: "private" }] },
    { checkpoint, files: [{ ...file, checkpoint: { ...checkpoint, id: "other" } }] }]) {
    const invalid = { ...event, data: { ...event.data, payload } };
    expect(projectRunOutputArtifactEvent(invalid)).toBeNull();
    expect(isRunOutputArtifactEvent(invalid)).toBe(false);
  }
});
