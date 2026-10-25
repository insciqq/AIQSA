import { describe, expect, it } from "vitest";
import {
  summarizeMessageRunArtifacts,
  summarizeMessageRunToolActivity,
  summarizeMessageRunWorkspaceActivity
} from "./prismaRepository";
import { namespacedWorkspaceToolName } from "../workspace/toolCatalog";
import { unknownToolCallResult } from "../runs/unknownToolCall";
import { summarizeThreadArtifacts } from "../../../components/app-shell/threadContent";
import { projectRunOutputArtifactEvent } from "../runs/runOutputEvents";
import { makeContextCompactionStatus } from "../../contracts/contextCompaction";
import {
  THREAD_CITATION_MAX_ITEMS,
  THREAD_REASONING_MAX_CHARACTERS,
  decodeChatMessagesPageResponse
} from "../../contracts/chats";
import { createReasoningFragmentBuffer } from "../../domain/answerReasoning";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import type { ScheduledTask } from "../../contracts/scheduledTasks";

/** Provider events → durable rows → reload summary → browser decoder, beside the live summary. */
function roundTrip(providerEvents: readonly ModelRunSseEvent[], storedRows: readonly unknown[] = []) {
  const durable = providerEvents.flatMap((event) => {
    const projected = projectRunOutputArtifactEvent(event);
    return projected ? [projected] : [];
  });
  const reloaded = summarizeMessageRunArtifacts({
    events: [
      ...storedRows.map((payload) => ({ eventType: "artifact", payload })),
      ...durable.map((event) => ({ eventType: event.type, payload: event.data }))
    ],
    searchRuns: []
  });
  const page = decodeChatMessagesPageResponse(JSON.parse(JSON.stringify({
    messages: [{
      artifactSummary: reloaded,
      citationMessageId: null,
      content: { blocks: [{ text: "Answer", type: "text" }] },
      createdAt: "2026-09-27T00:00:00.000Z",
      errorMessage: null,
      id: "message-1",
      modelId: "model",
      modelRunId: "run-1",
      parentMessageId: null,
      provider: "provider",
      role: "assistant",
      status: "complete"
    }],
    pageInfo: {
      activeLeafMessageId: "message-1",
      beforeCursor: null,
      hasOlder: false,
      snapshotUpdatedAt: "2026-09-27T00:00:00.000Z"
    }
  })) as unknown);
  return {
    decoded: page?.messages[0]?.artifactSummary,
    live: summarizeThreadArtifacts([...providerEvents]),
    page,
    reloaded
  };
}

function reasoningEvent(payload: unknown): ModelRunSseEvent {
  return { data: { artifactType: "reasoning", payload }, type: "artifact" };
}

describe("answer artifact reload round trip", () => {
  it("measures a native run to its published answer and an old-core run to its first answer token", () => {
    const createdAt = new Date("2026-10-23T10:00:00.000Z");
    const run = { answerCompletedAt: new Date("2026-10-23T10:02:07.000Z"), answerStartedAt: new Date("2026-10-23T10:00:21.000Z"),
      createdAt, events: [], searchRuns: [], status: "complete", toolCalls: [{}], updatedAt: new Date("2026-10-23T10:02:30.000Z") };
    // A preamble before a 100 s tool call is not the end of the work.
    expect(summarizeMessageRunArtifacts({ ...run, engine: "native" })?.workDurationMs).toBe(127_000);
    expect(summarizeMessageRunArtifacts({ ...run, engine: "v1" })?.workDurationMs).toBe(21_000);
    // A native run that never published an answer ends at its terminal state.
    expect(summarizeMessageRunArtifacts({ ...run, answerCompletedAt: null, engine: "native", status: "error" })?.workDurationMs)
      .toBe(150_000);
  });

  it("merges more than 100 streamed thinking deltas into one exact, reloadable entry", () => {
    const deltas = Array.from({ length: 150 }, (_, index) =>
      index % 50 === 49 ? `step ${index}.\n\n` : `step ${index} 思考 😀 `);
    const fragments = createReasoningFragmentBuffer(64);
    const events = [
      ...deltas.flatMap((delta) => fragments.append(delta)),
      ...fragments.finish()
    ].map(reasoningEvent);
    expect(events.length).toBeGreaterThan(1);
    expect(events.length).toBeLessThan(deltas.length);

    const { decoded, live, page, reloaded } = roundTrip(events);
    expect(reloaded?.reasoningText).toEqual([deltas.join("").trim()]);
    expect(reloaded).not.toHaveProperty("reasoningTruncated");
    expect(page).not.toBeNull();
    expect(decoded?.reasoningText).toEqual(reloaded?.reasoningText);
    expect(live?.reasoningText).toEqual(reloaded?.reasoningText);
  });

  it("reads historical per-delta rows as one block without rewriting them", () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({
      artifactType: "reasoning",
      payload: { text: index === 60 ? "1. A listed step" : `delta ${index}` }
    }));
    const snapshot = structuredClone(rows);
    const { decoded, page } = roundTrip([], [
      ...rows,
      { artifactType: "citation", payload: { index: 1, title: "Between", url: "https://example.com/between" } },
      { artifactType: "reasoning", payload: { text: "A later block" } }
    ]);
    expect(page).not.toBeNull();
    expect(decoded?.reasoningText).toHaveLength(2);
    expect(decoded?.reasoningText[0]).toMatch(/^delta 0 delta 1 delta 2 /u);
    expect(decoded?.reasoningText[0]).toContain("delta 59\n\n1. A listed step delta 61");
    expect(decoded?.reasoningText[1]).toBe("A later block");
    expect(rows).toEqual(snapshot);
  });

  it("keeps more than 100 citations and every valid source across rounds", () => {
    const citations = Array.from({ length: 150 }, (_, index): ModelRunSseEvent => ({
      data: { artifactType: "citation", payload: {
        title: `Cited ${index}`, type: "url_citation", url: `https://example.com/${index % 120}`
      } },
      type: "artifact"
    }));
    const search = (sources: unknown[]): ModelRunSseEvent => ({
      data: { artifactType: "search", payload: { action: { sources }, id: "private-call" } },
      type: "artifact"
    });
    const rounds = Array.from({ length: 3 }, (_, round) => search(Array.from({ length: 20 }, (_, index) => ({
      type: "url", url: `https://round-${round}.example.com/${"p".repeat(index === 0 ? 600 : 1)}${index}`
    }))));
    const { decoded, live, page, reloaded } = roundTrip([
      ...citations,
      ...rounds,
      search([{ title: "Too long", url: `https://example.com/${"x".repeat(2_049)}` }])
    ]);
    expect(page).not.toBeNull();
    expect(reloaded?.citations).toHaveLength(120);
    expect(reloaded?.sources).toHaveLength(60);
    expect(reloaded?.sources[0]).toMatchObject({ rank: 1, title: "round-0.example.com" });
    expect(reloaded?.sources.some((source) => source.url.length > 2_048)).toBe(false);
    expect(decoded).toEqual(reloaded);
    expect(live).toEqual({ ...reloaded, groundingDisplay: null });
    expect(JSON.stringify(decoded)).not.toMatch(/private-call|url_citation/u);
  });

  it("marks, rather than silently drops, what the reader bounds leave out", () => {
    const citations = Array.from({ length: THREAD_CITATION_MAX_ITEMS + 1 }, (_, index): ModelRunSseEvent => ({
      data: { artifactType: "citation", payload: { title: `Cited ${index}`, url: `https://example.com/${index}` } },
      type: "artifact"
    }));
    const thinking = [
      reasoningEvent({ entry: "start", text: "a".repeat(THREAD_REASONING_MAX_CHARACTERS - 10) }),
      reasoningEvent({ entry: "start", text: `${"b".repeat(20)} tail` })
    ];
    const { decoded, live, reloaded } = roundTrip([...citations, ...thinking]);
    expect(reloaded?.citations).toHaveLength(THREAD_CITATION_MAX_ITEMS);
    expect(reloaded).toMatchObject({ citationsTruncated: true, reasoningTruncated: true });
    expect(reloaded?.reasoningText).toEqual(["a".repeat(THREAD_REASONING_MAX_CHARACTERS - 10), "b".repeat(10)]);
    expect(decoded).toMatchObject({ citationsTruncated: true, reasoningTruncated: true });
    expect(live).toMatchObject({ citationsTruncated: true, reasoningTruncated: true });
  });

  it("skips a corrupted optional row without losing the rest of the answer outputs", () => {
    const { decoded, page } = roundTrip([], [
      { artifactType: "reasoning", payload: { entry: "start", text: 42 } },
      { artifactType: "reasoning", payload: { encryptedContent: "private", id: "private-id" } },
      { artifactType: "citation", payload: { title: "Unsafe", url: "javascript:alert(1)" } },
      { artifactType: "citation", payload: { title: `${"t".repeat(600)}`, url: "https://example.com/kept" } },
      { artifactType: "reasoning", payload: { entry: "start", text: "Kept thinking" } }
    ]);
    expect(page).not.toBeNull();
    expect(decoded?.reasoningText).toEqual(["Kept thinking"]);
    expect(decoded?.citations).toEqual([{ index: 1, title: "t".repeat(500), url: "https://example.com/kept" }]);
    expect(JSON.stringify(decoded)).not.toMatch(/private|javascript/u);
  });
});

describe("summarizeMessageRunArtifacts", () => {
  it("keeps the newest successful version per answer in first-appearance order across live replay and reload", () => {
    const receipt = (artifactId: string, versionNumber: number) => projectRunOutputArtifactEvent({
      type: "artifact", data: { artifactType: "generated_artifact", payload: {
        artifactId, versionId: `${artifactId}-v${versionNumber}`, versionNumber,
        title: "Same title", kind: "html", entrypoint: "index.html"
      } }
    })!;
    const events = [receipt("A", 3), receipt("B", 1), receipt("A", 4), receipt("A", 4), receipt("A", 3)];
    const snapshot = structuredClone(events);
    const project = (answerEvents: typeof events) => {
      const live = summarizeThreadArtifacts(answerEvents)?.generatedArtifacts;
      const reloaded = summarizeMessageRunArtifacts({
        events: answerEvents.map(event => ({ eventType: event.type, payload: event.data })), searchRuns: []
      })?.generatedArtifacts;
      expect(reloaded).toEqual(live);
      return live?.map(artifact => artifact.versionId);
    };
    expect(project(events.slice(0, 1))).toEqual(["A-v3"]);
    expect(project(events.slice(0, 2))).toEqual(["A-v3", "B-v1"]);
    for (const length of [3, 4, 5]) expect(project(events.slice(0, length))).toEqual(["A-v4", "B-v1"]);
    expect(project([receipt("A", 2)])).toEqual(["A-v2"]);
    expect(project([receipt("A", 5)])).toEqual(["A-v5"]);
    expect(project(events)).toEqual(["A-v4", "B-v1"]);
    expect(events).toEqual(snapshot);
  });

  it("reloads a generated artifact receipt after durable projection", () => {
    const event = projectRunOutputArtifactEvent({ type: "artifact", data: {
      artifactType: "generated_artifact",
      payload: {
        artifact_id: "artifact-1", entrypoint: "index.html", kind: "slides",
        title: "Roadmap", version_id: "version-1", version_number: 2,
        providerPrivateField: "must be dropped"
      }
    } })!;
    const live = summarizeThreadArtifacts([event]);
    const reloaded = summarizeMessageRunArtifacts({
      events: [{ eventType: "artifact", payload: event.data }], searchRuns: []
    });
    expect(reloaded?.generatedArtifacts).toEqual(live?.generatedArtifacts);
    expect(JSON.stringify(reloaded)).not.toContain("providerPrivateField");
  });

  it("reloads the same safe Gemini display and citations as the live stream", () => {
    const event = projectRunOutputArtifactEvent({ type: "grounding_display", data: {
      provider: "gemini",
      suggestionsHtml: '<a href="https://www.google.com/search?q=weather">Weather</a>',
      citations: [{ startIndex: 0, endIndex: 8, title: "Source", url: "https://example.test/source" }]
    } })!;
    const live = summarizeThreadArtifacts([event]);
    const reloaded = summarizeMessageRunArtifacts({
      events: [{ eventType: event.type, payload: event.data }], searchRuns: []
    });
    expect(reloaded).toEqual(live);
    expect(JSON.stringify(reloaded)).not.toMatch(/startIndex|endIndex|runSearch/);
  });

  it("projects only the friendly Memory availability state", () => {
    const summary = summarizeMessageRunArtifacts(
      { events: [], searchRuns: [] },
      null,
      [],
      "UNAVAILABLE"
    );

    expect(summary).toEqual({
      citations: [],
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

  it("merges every engine's cited sources into one URL-deduplicated list without their citation numbers", () => {
    const engine = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => ({
      citation: index + 1, rank: index + 1, title: `${prefix} ${index + 1}`, url: `https://example.com/${prefix}/${index + 1}`
    }));
    const perplexity = engine("perplexity", 15);
    const openai = [
      { ...perplexity[14]!, citation: 1, rank: 1, title: "Shared" },
      ...engine("openai", 2).map((source) => ({ ...source, citation: source.citation + 1, rank: source.rank + 1 })),
      { rank: 4, title: "Browsed", url: "https://example.com/browsed" }
    ];

    const summary = summarizeMessageRunArtifacts({
      events: [],
      searchRuns: [{ artifacts: { sources: perplexity } }, { artifacts: { sources: openai } }]
    });

    expect(summary?.sources?.map((source) => source.url)).toEqual([
      ...perplexity.map((source) => source.url),
      ...openai.slice(1).map((source) => source.url)
    ]);
    expect(summary?.sources?.map((source) => source.rank)).toEqual(Array.from({ length: 18 }, (_, index) => index + 1));
    expect(JSON.stringify(summary?.sources)).not.toContain("citation");
  });

  it("keeps only a committed Memory action", () => {
    const action = { operation: "UPDATE" as const, status: "COMMITTED" as const };
    const withAction = summarizeMessageRunArtifacts(
      { events: [], searchRuns: [] },
      action
    );
    const withoutAction = summarizeMessageRunArtifacts(
      { events: [], searchRuns: [] },
      null
    );

    expect(withAction).toEqual({
      citations: [],
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

  it("reloads a content-free compaction outcome and ignores late progress", () => {
    const running = makeContextCompactionStatus({
      afterTokens: 600, beforeTokens: 1_200, outcome: "pending", state: "running"
    });
    const complete = makeContextCompactionStatus({
      afterTokens: 600, beforeTokens: 1_200, outcome: "summary_applied", state: "complete"
    });
    const summary = summarizeMessageRunArtifacts({
      events: [
        { eventType: "artifact", payload: { artifactType: "context_compaction", payload: running } },
        { eventType: "artifact", payload: { artifactType: "context_compaction", payload: complete } },
        { eventType: "artifact", payload: { artifactType: "context_compaction", payload: { ...running, notes: "private" } } }
      ],
      searchRuns: []
    });
    expect(summary?.contextCompaction).toEqual(complete);
    expect(JSON.stringify(summary)).not.toContain("private");
  });

  it("shows a checkpoint the final export delivers unchanged once, as the export, and keeps every changed or other file", () => {
    const createdAt = new Date("2026-10-01T10:00:00.000Z");
    const [same, older, other] = ["a", "b", "c"].map(digit => digit.repeat(64));
    const checkpoint = (id: string, relativePath: string, checksum: string | null, byteSize = 10, state = "SETTLED") => ({
      id, byteSize, checksum, fileName: relativePath.split("/").at(-1)!, mimeType: "application/pdf", workspaceRunOutput: null,
      workspaceCheckpointFile: { relativePath, checkpoint: { id: `checkpoint-${id}`, description: "Draft", createdAt, state } } });
    const exported = (id: string, relativePath: string, checksum: string, byteSize = 10) => ({
      id, byteSize, checksum, fileName: relativePath.split("/").at(-1)!, mimeType: "application/pdf",
      workspaceRunOutput: { relativePath }, workspaceCheckpointFile: null });
    const summary = summarizeMessageRunArtifacts({ events: [], searchRuns: [], workspaceProducedAttachments: [
      checkpoint("draft-identical", "output/report.pdf", same),
      checkpoint("draft-older", "output/report.pdf", older),
      checkpoint("draft-other-size", "output/report.pdf", same, 11),
      checkpoint("draft-project", "project/report.pdf", same),
      checkpoint("draft-nested", "output/docs/report.pdf", same),
      checkpoint("draft-unverified", "output/report.pdf", null),
      checkpoint("draft-unsettled", "output/report.pdf", same, 10, "PENDING"),
      exported("final", "report.pdf", same),
      exported("final-nested", "docs/report.pdf", other)
    ] });
    expect(summary?.generatedFiles?.map(file => [file.attachmentId, file.relativePath, Boolean(file.checkpoint)])).toEqual([
      ["draft-older", "output/report.pdf", true], ["draft-other-size", "output/report.pdf", true], ["draft-project", "project/report.pdf", true],
      ["draft-nested", "output/docs/report.pdf", true], ["draft-unverified", "output/report.pdf", true],
      ["final", "report.pdf", false], ["final-nested", "docs/report.pdf", false]
    ]);
    expect(JSON.stringify(summary)).not.toContain(same);
  });
});

describe("summarizeMessageRunToolActivity", () => {
  const acceptedMcpRequest = {
    mcp: {
      servers: [{ serverId: "server-fixture", revisionId: "revision-fixture", fingerprint: "fingerprint-fixture" }],
      tools: [{ namespacedName: "mcp_search_fixture", originalName: "search", serverId: "server-fixture",
        serverName: "Repository Tools" }]
    }
  };
  const referenceCall = {
    toolName: "mcp_search_fixture", ordinal: 3, roundIndex: 2, state: "complete",
    startedAt: null, completedAt: null,
    mcpRunBinding: { runtimeGenerationFingerprint: "fingerprint-fixture" },
    arguments: { privateRequest: "never projected" }, result: { privateResponse: "never projected" }
  };

  it.each(["running", "complete", "error", "cancelled"])("offers references for initiator-owned accepted MCP calls in %s state", state => {
    const activity = summarizeMessageRunToolActivity({ userId: "initiator", errorPayload: null,
      normalizedRequest: acceptedMcpRequest, status: state, toolCalls: [{ ...referenceCall, state }] }, "initiator");
    expect(activity?.calls[0]).toEqual({ details: { roundIndex: 2, ordinal: 3 }, origin: "mcp", round: 2,
      serverName: "Repository Tools", status: state, toolName: "search" });
    expect(JSON.stringify(activity)).not.toMatch(/private|fingerprint|revision|server-fixture|mcp_search/);
  });

  it("shows a call of an undeclared tool as a plain failed step, never as a call of a server's tool", () => {
    const unknown = (toolName: string, providerCallId = "provider-unknown") => ({ toolName, providerCallId, ordinal: 0, roundIndex: 2,
      state: "error", startedAt: null, completedAt: new Date("2026-10-19T10:00:00.000Z"),
      mcpRunBinding: { runtimeGenerationFingerprint: "fingerprint-fixture" }, arguments: {},
      result: unknownToolCallResult({ providerCallId, requested: `${toolName}?DSML?`, toolName }) });
    // Even under an accepted MCP tool's exact name, bound or not, it never ran: no server, details or MCP origin.
    for (const call of [unknown("mcp_search_fixture"), unknown("read_note"), unknown("invalid_tool_name")]) {
      const activity = summarizeMessageRunToolActivity({ userId: "initiator", errorPayload: null,
        normalizedRequest: acceptedMcpRequest, status: "complete", toolCalls: [call] }, "initiator");
      expect(activity?.calls).toEqual([{ origin: "tool", round: 2, status: "error", toolName: call.toolName }]);
      expect(JSON.stringify(activity)).not.toMatch(/DSML|Repository Tools/u);
    }
    // The same body from a dispatched call is an ordinary step of its tool.
    expect(summarizeMessageRunToolActivity({ userId: "initiator", errorPayload: null, normalizedRequest: acceptedMcpRequest,
      status: "complete", toolCalls: [{ ...unknown("mcp_search_fixture"), startedAt: new Date("2026-10-19T09:59:59.000Z") }] },
    "initiator")?.calls[0]).toMatchObject({ origin: "mcp", serverName: "Repository Tools" });
  });

  it.each(["complete", "cancelled", "error"])("shows calls left open by a %s run as stopped steps", runStatus => {
    const call = (state: string, result: unknown = null) => ({ toolName: "lookup_records", ordinal: 0, roundIndex: 1, state,
      startedAt: null, completedAt: null, arguments: {}, result });
    const project = (status: string, toolCalls: ReturnType<typeof call>[]) => summarizeMessageRunToolActivity({
      userId: "initiator", errorPayload: null, normalizedRequest: {}, status, toolCalls }, "initiator")?.calls.map(entry => entry.status);
    const closedByRunEnd = { code: "run_ended_before_tool_settled", outcome: "unknown" };
    expect(project(runStatus, [call("running"), call("pending"), call("error", closedByRunEnd), call("error", { code: "x" }),
      call("complete")])).toEqual(["cancelled", "cancelled", "cancelled", "error", "complete"]);
    // A live run still shows its open calls as running.
    expect(project("streaming", [call("running"), call("pending")])).toEqual(["running", "running"]);
  });

  it.each([undefined, "other-member", "administrator"])("keeps references unavailable to viewer %s", viewer => {
    const activity = summarizeMessageRunToolActivity({ userId: "initiator", errorPayload: null,
      normalizedRequest: acceptedMcpRequest, status: "complete", toolCalls: [referenceCall] }, viewer);
    expect(activity?.calls[0]).not.toHaveProperty("details");
  });

  it("shows the initiator the servers a tool search could not load, by name and reason only", () => {
    const discoveryRequest = { mcpDiscovery: {
      catalog: { servers: [{ serverId: "server-private-id", serverName: "Gitlab\u0007 Main", tools: [] }], version: 1 },
      epochs: [{ epoch: 1, goal: "private query", modelRunToolCallId: "persisted-find-tools", roundIndex: 1, toolIds: [],
        unavailable: [{ reason: "mcp_reauthorization_required", serverId: "server-private-id" }] }],
      version: 2
    } };
    const findCall = { id: "persisted-find-tools", toolName: "find_tools", ordinal: 0, roundIndex: 1, state: "complete",
      startedAt: null, completedAt: null, arguments: { query: "private query" }, result: { private: "result text" } };
    const run = { userId: "initiator", errorPayload: null, status: "complete", normalizedRequest: discoveryRequest,
      toolCalls: [findCall] };
    const activity = summarizeMessageRunToolActivity(run, "initiator");
    expect(activity?.calls[0]).toEqual({ mcpUnavailable: [{ name: "Gitlab Main", reason: "mcp_reauthorization_required" }],
      origin: "discovery", round: 1, serverName: "Auto tools", status: "complete", toolName: "find_tools" });
    expect(JSON.stringify(activity)).not.toMatch(/private|persisted-find-tools/u);
    // Other viewers (administrators) and anonymous readers see nothing new.
    for (const viewer of [undefined, "other-member", "administrator"]) {
      expect(summarizeMessageRunToolActivity(run, viewer)?.calls[0]).not.toHaveProperty("mcpUnavailable");
    }
    // An epoch without the set, or another call's epoch, adds nothing.
    expect(summarizeMessageRunToolActivity({ ...run, toolCalls: [{ ...findCall, id: "other-call" }] }, "initiator")?.calls[0])
      .not.toHaveProperty("mcpUnavailable");
  });

  it("projects a page read as its host/path and outcome, never the URL query, arguments or page text", () => {
    const pageCall = { toolName: "fetch_url", ordinal: 0, roundIndex: 1, state: "error", startedAt: null, completedAt: null,
      arguments: { url: "https://news.example/today?token=private-token" },
      result: { callId: "provider-call", name: "fetch_url", status: "error", content: [{ type: "json", value: {
        error: "fetch_http_status", httpStatus: 404, message: "private message" } }],
      rawPreview: { fetchUrl: { version: 1, outcome: "fetch_http_status", dispatched: true, httpStatus: 404,
        url: "https://news.example/today?token=private-token" } } } };
    const run = { userId: "initiator", errorPayload: null, status: "complete",
      normalizedRequest: { fetchUrl: { version: 1, userUrlDigests: [] } } };
    const activity = summarizeMessageRunToolActivity({ ...run, toolCalls: [pageCall] }, "initiator");
    expect(activity?.calls[0]).toEqual({ fetchHttpStatus: 404, fetchOutcome: "fetch_http_status", fetchTarget: "news.example/today",
      origin: "web_fetch", round: 1, serverName: "Web", status: "error", toolName: "fetch_url" });
    expect(JSON.stringify(activity)).not.toMatch(/private|token|https/u);
    // A run without the page reader projects no page facts for a call of that name.
    expect(summarizeMessageRunToolActivity({ ...run, normalizedRequest: {}, toolCalls: [pageCall] }, "initiator")?.calls[0])
      .not.toHaveProperty("fetchTarget");
  });

  it("requires exact persisted MCP provenance and excludes all native origins", () => {
    const run = { userId: "initiator", errorPayload: null, normalizedRequest: acceptedMcpRequest, status: "complete" };
    for (const call of [
      { ...referenceCall, mcpRunBinding: null },
      { ...referenceCall, mcpRunBinding: { runtimeGenerationFingerprint: "different-generation" } },
      { ...referenceCall, toolName: "mcp_prefix_only" },
      { ...referenceCall, ordinal: -1 },
      { ...referenceCall, roundIndex: 0 },
      ...["search", "find_tools", "memory_search", "load_skill", "generate_image",
        "create_artifact", "session", namespacedWorkspaceToolName("sandbox_fs_read")]
        .map(toolName => ({ ...referenceCall, toolName }))
    ]) {
      expect(summarizeMessageRunToolActivity({ ...run, toolCalls: [call] }, "initiator")?.calls[0])
        .not.toHaveProperty("details");
    }
    expect(summarizeMessageRunToolActivity({ ...run, normalizedRequest: {}, toolCalls: [referenceCall] }, "initiator")
      ?.calls[0]).not.toHaveProperty("details");
    expect(summarizeMessageRunToolActivity({ ...run, normalizedRequest: { ...acceptedMcpRequest, agent: {} },
      toolCalls: [referenceCall] }, "initiator")).toBeNull();
  });

  it.each(["results", "no_results", "limited", "failure", "cancelled"])("projects only native Memory search outcome %s", outcome => {
    const activity = summarizeMessageRunToolActivity({ errorPayload: null, status: "complete", normalizedRequest: {},
      toolCalls: [{ ordinal: 2, roundIndex: 1, startedAt: null, completedAt: null,
        state: outcome === "failure" || outcome === "cancelled" ? "error" : "complete",
        toolName: "memory_search", arguments: { query: "private-query" }, result: {
          content: [{ type: "json", value: { version: "memory-search-v1", outcome, evidence: "private-evidence" } }]
        } }] });
    expect(activity?.calls[0]).toMatchObject({ origin: "memory", serverName: "Memory",
      toolName: "memory_search", memorySearchCall: 3, memorySearchOutcome: outcome,
      status: outcome === "cancelled" ? "cancelled" : outcome === "failure" ? "error" : "complete" });
    expect(JSON.stringify(activity)).not.toMatch(/private|evidence|query/);
  });

  it("projects all-selected engine outcomes without exposing the technical tool name", () => {
    const activity = summarizeMessageRunToolActivity({ errorPayload: null, status: "complete",
      normalizedRequest: { searchPlan: { mode: "all_selected", options: [
        { optionId: "perplexity", displayName: "Perplexity", adapterKind: "provider_model_client" },
        { optionId: "openai", displayName: "OpenAI (CodexLB)", adapterKind: "provider_model_client" }
      ] } },
      toolCalls: [{ completedAt: null, startedAt: null, ordinal: 0, roundIndex: 1,
        state: "complete", toolName: "search_selected_engines" }],
      searchRuns: [
        { invocationId: "call:perplexity", strategyId: "perplexity", status: "complete" },
        { invocationId: "call:openai", strategyId: "openai", status: "complete" }
      ] });
    expect(activity?.calls[0]).toMatchObject({ origin: "web_search", serverName: "Web search", toolName: "search", round: 1 });
    expect(activity?.searchEngines?.map(row => row.complete)).toEqual([1, 1]);
    expect(JSON.stringify(activity)).not.toMatch(/search_selected_engines|invocationId|strategyId|optionId/iu);
  });

  it("keeps a historical Knowledge preflight readable as a plain step of the first round", () => {
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
        origin: "tool",
        round: 1,
        status: "complete",
        toolName: "retrieve_knowledge"
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
          origin: "discovery",
          round: 1,
          serverName: "Auto tools",
          status: "complete",
          toolName: "find_tools"
        },
        {
          durationMs: 300,
          origin: "mcp",
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

  it.each(["error", "cancelled", "streaming", "complete"])("keeps the accepted round limit visible for %s synthesis", (status) => {
    expect(summarizeMessageRunToolActivity({
      errorPayload: { code: "synthesis_tool_call_forbidden" },
      normalizedRequest: { toolBudgets: { maxToolCalls: 20, maxToolRounds: 8 } }, status,
      toolCalls: Array.from({ length: 8 }, (_, index) => ({ completedAt: null, startedAt: null,
        ordinal: 0, roundIndex: index + 1, state: index >= 6 ? "error" : "complete", toolName: "search" }))
    })?.warning).toEqual({ kind: "rounds", limit: 8 });
  });

  it("excludes a preflight call before the first provider round from tool call and round limits", () => {
    expect(summarizeMessageRunToolActivity({
      errorPayload: null,
      normalizedRequest: { toolBudgets: { maxToolCalls: 2, maxToolRounds: 2 } }, status: "streaming",
      toolCalls: [0, 1].map((roundIndex) => ({ completedAt: null, startedAt: null, ordinal: 0,
        roundIndex, state: "complete", toolName: roundIndex === 0 ? "retrieve_knowledge" : "search" }))
    })?.warning).toBeUndefined();
  });

  it("preserves accepted MCP origin through colliding names and every persisted outcome", () => {
    const activity = summarizeMessageRunToolActivity({
      errorPayload: { message: "unexposed diagnostic" },
      normalizedRequest: {
        mcp: { tools: [{
          namespacedName: "mcp_repository_search_fixture",
          originalName: "search",
          serverName: "Repository Tools"
        }] },
        mcpDiscovery: { catalog: { servers: [{
          serverName: "Workspace",
          tools: [{ namespacedName: "mcp_catalog_discovery_fixture", originalName: "find_tools" }]
        }] } },
        searchPlan: { options: [{ displayName: "Catalog Search" }] }
      },
      status: "error",
      toolCalls: [
        ...["running", "complete", "error", "cancelled"].map((state, index) => ({
          completedAt: null,
          ordinal: 0,
          roundIndex: index + 1,
          startedAt: null,
          state,
          toolName: "mcp_repository_search_fixture"
        })),
        { completedAt: null, ordinal: 0, roundIndex: 5, startedAt: null, state: "error", toolName: "mcp_catalog_discovery_fixture" },
        { completedAt: null, ordinal: 0, roundIndex: 6, startedAt: null, state: "complete", toolName: "search_engine_1" }
      ]
    });

    expect(activity?.calls).toEqual([
      // The failed run left its running call as a stopped step.
      ...["cancelled", "complete", "error", "cancelled"].map((status, index) => ({
        origin: "mcp", round: index + 1, serverName: "Repository Tools", status, toolName: "search"
      })),
      { origin: "mcp", round: 5, serverName: "Workspace", status: "error", toolName: "find_tools" },
      { origin: "web_search", round: 6, serverName: "Catalog Search", status: "complete", toolName: "search" }
    ]);
    expect(JSON.stringify(activity)).not.toMatch(/unexposed|mcp_repository|mcp_catalog|arguments|result/iu);
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
      origin: "workspace",
      serverName: "Workspace",
      toolName: "sandbox_fs_read"
    });
  });
});

describe("summarizeMessageRunWorkspaceActivity", () => {
  it.each([
    [19, "FAILED", "complete", null, "retrying"],
    [19, "PENDING", "complete", null, "retrying"],
    [19, "EXPORTING", "complete", new Date(0), "retrying"],
    [20, "EXPORTING", "complete", new Date(Date.now() + 60_000), "exporting"],
    [20, "COMPLETE", "complete", null, "complete"],
    [0, "FAILED", "cancelled", null, "failed"],
    [0, "FAILED", "error", null, "failed"],
    [0, "PENDING", "cancelled", null, undefined],
    [0, "PENDING", "error", null, undefined]
  ] as const)("projects durable export eligibility %s/%s/%s", (exportAttemptCount, exportState, status, exportLeaseExpiresAt, expected) => {
    const projected = summarizeMessageRunWorkspaceActivity({ events: [], status,
      workspaceRunBinding: { exportAttemptCount, exportLeaseExpiresAt, exportState, lastExportErrorCode: null }
    });
    expect(projected?.outputStatus).toEqual(expected ? { state: expected } : undefined);
    expect(JSON.stringify(projected)).not.toMatch(/exportAttemptCount|exportLeaseExpiresAt/u);
  });

  it.each(["FAILED", "PENDING", "EXPORTING"] as const)("does not promise another export after the attempt budget is exhausted in %s", (exportState) => {
    const run = { events: [], status: "complete", workspaceRunBinding: {
      exportAttemptCount: 20, exportLeaseExpiresAt: new Date(0), exportState,
      lastExportErrorCode: "workspace_output_export_failed"
    } };
    expect(summarizeMessageRunWorkspaceActivity(run)?.outputStatus?.state).toBe("failed");
  });

  const entry = (id: string, phase: string, extra: Record<string, unknown> = {}) => ({
    artifactType: "workspace_activity",
    payload: { command: { preview: "npm test" }, id, kind: "command", phase, ...extra }
  });

  it.each([
    ["running", "COMPLETE", 1, "succeeded"],
    ["failed", "COMPLETE", 2, "succeeded"],
    ["running", "FAILED", 20, "failed"],
    ["running", "PENDING", 1, "running"]
  ] as const)("reconciles the export timeline after answer SSE closes: %s/%s", (phase, exportState, exportAttemptCount, expected) => {
    const output = { id: "export", kind: "outputs_export", phase, count: 2, sequence: 7 };
    const projected = summarizeMessageRunWorkspaceActivity({
      events: [{ payload: { artifactType: "workspace_activity", payload: output } }],
      status: "complete",
      workspaceRunBinding: { exportAttemptCount, exportLeaseExpiresAt: null, exportState, lastExportErrorCode: null }
    });
    expect(projected?.entries).toEqual([{ ...output, firstSequence: 7, phase: expected }]);
  });

  it("keeps a handed-off export row's skipped counts when the finished transfer settles it on reload", () => {
    const output = { count: 1, id: "export", kind: "outputs_export", phase: "running", sequence: 7, skipped: { link: 1 } };
    expect(summarizeMessageRunWorkspaceActivity({
      events: [{ payload: { artifactType: "workspace_activity", payload: output } }],
      status: "complete",
      workspaceRunBinding: { exportAttemptCount: 1, exportLeaseExpiresAt: null, exportState: "COMPLETE", lastExportErrorCode: null }
    })?.entries).toEqual([{ ...output, firstSequence: 7, phase: "succeeded" }]);
  });

  it("folds persisted entries, settles running steps from the run outcome, and projects export state", () => {
    expect(summarizeMessageRunWorkspaceActivity({
      events: [
        { payload: { artifactType: "reasoning", payload: { text: "ignored" } } },
        { payload: entry("call:one", "running") },
        { payload: entry("call:one", "succeeded", { command: { exitCode: 0, preview: "npm test" } }) },
        { payload: entry("call:two", "running") },
        { payload: { artifactType: "workspace_activity", payload: { id: "bad", kind: "sandbox_exec", phase: "running" } } }
      ],
      status: "cancelled",
      workspaceRunBinding: { exportAttemptCount: 0, exportLeaseExpiresAt: null, exportState: "FAILED", lastExportErrorCode: "workspace_output_export_failed" }
    })).toEqual({
      entries: [
        { command: { exitCode: 0, preview: "npm test" }, id: "call:one", kind: "command", phase: "succeeded" },
        { command: { preview: "npm test" }, id: "call:two", kind: "command", phase: "unknown" }
      ],
      outputStatus: { errorCode: "workspace_output_export_failed", state: "failed" }
    });
    expect(summarizeMessageRunWorkspaceActivity({
      events: [],
      status: "complete",
      workspaceRunBinding: { exportAttemptCount: 0, exportLeaseExpiresAt: null, exportState: "FAILED", lastExportErrorCode: "workspace_output_limit_exceeded" }
    })).toEqual({
      entries: [],
      outputStatus: { errorCode: "workspace_output_limit_exceeded", state: "failed" }
    });
    expect(summarizeMessageRunWorkspaceActivity({
      events: [],
      status: "streaming",
      workspaceRunBinding: { exportAttemptCount: 0, exportLeaseExpiresAt: null, exportState: "PENDING", lastExportErrorCode: null }
    })).toBeNull();
    expect(summarizeMessageRunWorkspaceActivity({
      events: [],
      status: "complete",
      workspaceRunBinding: { exportAttemptCount: 0, exportLeaseExpiresAt: null, exportState: "COMPLETE", lastExportErrorCode: null }
    })).toEqual({ entries: [], outputStatus: { state: "complete" } });
    expect(summarizeMessageRunWorkspaceActivity({ events: [], status: "complete", workspaceRunBinding: null }))
      .toBeNull();
  });
});

describe("Workspace terminal proof projection", () => {
  it("uses only exact run-owned registry closure and distinguishes legacy LOST", async () => {
    const { workspaceActivityEntryId } = await import("../workspace/activityProjection");
    const calls = ["closed-call", "stopped-call", "lost-call", "missing-call"];
    const projected = summarizeMessageRunWorkspaceActivity({ id: "run", status: "complete",
      events: calls.map(call => ({ payload: { artifactType: "workspace_activity", payload: {
        id: workspaceActivityEntryId(call), kind: "command", phase: "running", command: { preview: "bounded command" }
      } } })), workspaceExecutions: [
        { modelRunToolCallId: calls[0]!, state: "CLOSED", lastErrorCode: null },
        { modelRunToolCallId: calls[1]!, state: "LOST", lastErrorCode: "workspace_execution_stopped" },
        { modelRunToolCallId: calls[2]!, state: "LOST", lastErrorCode: null }
      ] });
    expect(projected?.entries.map(entry => entry.phase)).toEqual(["closed", "closed", "unknown", "unknown"]);
    expect(JSON.stringify(projected)).not.toMatch(/modelRunToolCallId|CLOSED|LOST|missing-call/u);
  });

  it("reconstructs completed sealed handoff without looking at a successor session, preserving nonzero", () => {
    const run = { id: "old-run", status: "complete", events: [
      { payload: { artifactType: "workspace_activity", payload: { id: "unpolled", kind: "command", phase: "running", command: { preview: "work" } } } },
      { payload: { artifactType: "workspace_activity", payload: { id: "failed", kind: "command", phase: "failed", command: { preview: "check", exitCode: 17 } } } }
    ], workspaceRunBinding: { exportState: "COMPLETE", exportAttemptCount: 1, exportLeaseExpiresAt: null,
      lastExportErrorCode: null, updatedAt: new Date("2026-09-24T10:00:00.000Z"), outputCapture: { id: "private-capture", outputs: [] } } };
    const activity = summarizeMessageRunWorkspaceActivity(run)!;
    expect(activity.entries[0]).toMatchObject({ phase: "closed" });
    expect(activity.entries[1]).toMatchObject({ phase: "failed", command: { exitCode: 17 } });
    expect(activity.outputStatus).toEqual({ state: "complete", revision: "2026-09-24T10:00:00.000Z" });
    expect(JSON.stringify(activity)).not.toContain("private-capture");
    expect(summarizeMessageRunWorkspaceActivity({ ...run, workspaceRunBinding: { ...run.workspaceRunBinding, outputCapture: null } })?.entries[0]?.phase).toBe("unknown");
  });
});

describe("scheduled task cards", () => {
  const card = {
    taskId: "task-1", title: "Check mail", kind: "standard" as const,
    schedule: { kind: "weekly" as const, time: "09:00", days: ["mon" as const, "tue" as const, "wed" as const, "thu" as const, "fri" as const] },
    timeZone: "Europe/Moscow", timeZoneFallback: false, toolsEnabled: true, workspaceEnabled: false, status: "active" as const,
    nextRunAt: "2026-10-05T06:00:00.000Z"
  };
  const created = { data: { artifactType: "scheduled_task" as const, payload: card }, type: "artifact" as const };
  const task: ScheduledTask = {
    ...card, id: "task-1", prompt: "Remind me to check my mail.", scheduleEnabled: true, webhookEnabled: false, webhook: null,
    modelId: "deployment-1", provider: "connection-1",
    searchEnabled: false, emailNotify: false, telegramNotify: false, memoryEnabled: false, pinnedSkillIds: [], chatMode: "new", historyRetentionDays: 90,
    historyDeletedChats: 0, historyNextDeletionAt: null, pauseReason: null, completionReason: null,
    lastRun: null, running: false, chatId: null, unseenResult: false, revision: 2, createdAt: "2026-10-04T10:00:00.000Z",
    updatedAt: "2026-10-04T11:00:00.000Z"
  };

  it("shows the created task live and after reload, once however often a recovered answer publishes it", () => {
    const { decoded, live, reloaded } = roundTrip([created, created]);
    expect(live?.scheduledTasks).toEqual([card]);
    expect(reloaded?.scheduledTasks).toEqual([card]);
    expect(decoded?.scheduledTasks).toEqual([card]);
  });

  it("keeps only an exact created card at the durable boundary", () => {
    for (const payload of [{ ...card, deleted: true }, { ...card, prompt: "Private instructions" }, { ...card, nextRunAt: "soon" },
      { ...card, status: "paused" }, { ...card, schedule: { kind: "daily", time: "25:00" } }]) {
      expect(projectRunOutputArtifactEvent({ ...created, data: { ...created.data, payload } } as ModelRunSseEvent)).toBeNull();
    }
    expect(projectRunOutputArtifactEvent(created)).toEqual(created);
  });

  it("reads the owner's current task over the created card, and a gone task as deleted", () => {
    const run = { events: [{ eventType: "artifact", payload: created.data }], searchRuns: [] };
    const edited = new Map([["task-1", { ...task, title: "Inbox", status: "paused" as const, nextRunAt: null, workspaceEnabled: true }]]);
    expect(summarizeMessageRunArtifacts(run, null, [], undefined, edited)?.scheduledTasks)
      .toEqual([{ ...card, title: "Inbox", status: "paused", nextRunAt: null, workspaceEnabled: true, scheduleEnabled: true }]);
    expect(summarizeMessageRunArtifacts(run, null, [], undefined, new Map())?.scheduledTasks)
      .toEqual([{ ...card, deleted: true }]);
    // A run's own chat update has no current read: the task shows as created.
    expect(summarizeMessageRunArtifacts(run)?.scheduledTasks).toEqual([card]);
  });
});
