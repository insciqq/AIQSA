import { describe, expect, it } from "vitest";
import {
  projectClientSearchActivity,
  projectHostedSearchActivity,
  projectSearchRunActivity
} from "./searchDisclosure";
import type { ThreadToolActivity } from "../contracts/toolActivity";

function searchToolCall(input: Readonly<{
  callId: string;
  errorMessage?: string | null;
  query: string;
  searchExecutions?: ThreadToolActivity["searchExecutions"];
  status: ThreadToolActivity["status"];
}>): ThreadToolActivity {
  return {
    argumentsPreview: { query: input.query },
    callId: input.callId,
    capability: "web_search",
    credentialSources: [],
    durationMs: 1,
    errorMessage: input.errorMessage ?? null,
    externalAccountLabel: null,
    ordinal: 0,
    resultPreview: null,
    round: 1,
    ...(input.searchExecutions ? { searchExecutions: input.searchExecutions } : {}),
    serverName: null,
    status: input.status,
    toolName: "search_selected_engines"
  };
}

describe("Search disclosure projection", () => {
  it.each([
    ["cancelled", "cancelled"],
    ["error", "error"]
  ] as const)(
    "settles an unresolved provider trace when the run becomes %s",
    (runStatus, expectedStatus) => {
      expect(projectHostedSearchActivity({
        displayName: "OpenAI Search",
        payloads: [{
          action: { type: "search" },
          id: "operation-running",
          status: "in_progress",
          type: "web_search_call"
        }],
        runStatus
      })).toMatchObject({ status: expectedStatus });
    }
  );

  it("preserves completed provider operations while settling only unresolved operations", () => {
    expect(projectHostedSearchActivity({
      displayName: "OpenAI Search",
      payloads: [{
        action: { type: "search" },
        id: "operation-complete",
        status: "completed",
        type: "web_search_call"
      }],
      runStatus: "error"
    })).toMatchObject({ status: "complete" });

    expect(projectHostedSearchActivity({
      displayName: "OpenAI Search",
      payloads: [
        {
          action: { type: "search" },
          id: "operation-complete",
          status: "completed",
          type: "web_search_call"
        },
        {
          action: { type: "open_page", url: "https://example.com/source" },
          id: "operation-running",
          status: "in_progress",
          type: "web_search_call"
        }
      ],
      runStatus: "cancelled"
    })).toMatchObject({ status: "partial" });
  });

  it("never scans arbitrary provider previews for source URLs", () => {
    const activity = projectSearchRunActivity({
      artifacts: {
        finalProviderResponsePreview: {
          endpoint: "https://provider.example/v1/responses",
          metadata: { url: "https://internal.example/trace" },
          output: [{ title: "Unrelated", url: "https://unrelated.example/result" }]
        }
      },
      query: "safe query",
      status: "complete"
    });

    expect(activity).toMatchObject({
      query: "safe query",
      sourceCount: null,
      sources: []
    });
    expect(JSON.stringify(activity)).not.toContain("provider.example");
    expect(JSON.stringify(activity)).not.toContain("internal.example");
    expect(JSON.stringify(activity)).not.toContain("unrelated.example");
  });

  it("accepts only the narrowly recognized historical Search source shapes", () => {
    const activity = projectSearchRunActivity({
      artifacts: {
        finalProviderResponsePreview: {
          endpoint: "https://provider.example/v1/responses",
          searchExecutions: [{
            routeUrl: "https://internal.example/search-route",
            sources: [
              {
                description: "Evidence snippet",
                href: "https://example.com/evidence",
                publishedAt: "2026-08-03",
                title: "Evidence"
              },
              { title: "Unsafe", url: "javascript:alert(1)" }
            ]
          }]
        },
        providerOperations: [{
          id: "operation-1",
          kind: "open_page",
          ordinal: 0,
          pattern: null,
          queries: [],
          status: "complete",
          url: "https://username:password@example.com/private"
        }]
      },
      status: "complete"
    }, "Company Search");

    expect(activity).toMatchObject({
      displayName: "Company Search",
      providerOperations: null,
      sourceCount: 1,
      sources: [{
        date: "2026-08-03",
        rank: 1,
        snippet: "Evidence snippet",
        title: "Evidence",
        url: "https://example.com/evidence"
      }]
    });
    expect(JSON.stringify(activity)).not.toContain("provider.example");
    expect(JSON.stringify(activity)).not.toContain("internal.example");
    expect(JSON.stringify(activity)).not.toContain("javascript:");
    expect(JSON.stringify(activity)).not.toContain("username:password");
  });

  it("preserves an explicitly observed empty historical source list", () => {
    expect(projectSearchRunActivity({
      artifacts: {
        finalProviderResponsePreview: {
          searchExecutions: [{ sources: [] }]
        }
      },
      status: "complete"
    })).toMatchObject({ sourceCount: 0, sources: [] });
  });

  it("projects a friendly bounded reason from normalized SearchRun failure evidence", () => {
    const activity = projectSearchRunActivity({
      artifacts: {
        failure: {
          code: "openai_response_incomplete",
          providerStatus: "incomplete",
          reason: "max_output_tokens",
          rawProviderMessage: "private upstream detail"
        },
        warning: "legacy raw warning must not win"
      },
      query: "latest evidence",
      status: "error"
    }, "OpenAI Search");

    expect(activity).toMatchObject({
      displayName: "OpenAI Search",
      failureReason: "Search reached its output limit before completing.",
      query: "latest evidence",
      status: "error"
    });
    expect(JSON.stringify(activity)).not.toMatch(/private upstream|legacy raw|providerStatus|max_output_tokens/);
  });

  it("keeps a locally rejected attempt beside a persisted provider execution", () => {
    const execution = {
      displayName: "OpenAI Search",
      durationMs: 20,
      modelId: "search-model",
      optionId: "openai-search",
      provider: "openai",
      providerOperations: null,
      providerOperationsTruncated: false,
      query: "first query",
      sourceCount: 1,
      sources: [{ rank: 1, title: "Evidence", url: "https://example.com/evidence" }],
      status: "complete" as const,
      warning: null
    };
    const activities = projectClientSearchActivity({
      searchRuns: [{
        artifacts: {
          displayName: "OpenAI Search",
          invocationId: "call-1:openai-search",
          sources: execution.sources
        },
        query: execution.query,
        status: "complete",
        strategyId: execution.optionId
      }],
      toolCalls: [
        searchToolCall({
          callId: "call-1",
          query: execution.query,
          searchExecutions: [execution],
          status: "complete"
        }),
        searchToolCall({
          callId: "call-2",
          errorMessage: "search_invocation_limit_reached",
          query: "second query",
          status: "error"
        })
      ]
    });

    expect(activities).toEqual([
      expect.objectContaining({ query: "first query", status: "complete" }),
      expect.objectContaining({
        failureReason: "This Search source reached its request limit for this answer.",
        query: "second query",
        status: "error"
      })
    ]);
  });

  it("preserves tool-call order when a rejected attempt precedes a persisted execution", () => {
    const execution = {
      displayName: "OpenAI Search",
      durationMs: 20,
      modelId: "search-model",
      optionId: "openai-search",
      provider: "openai",
      providerOperations: null,
      providerOperationsTruncated: false,
      query: "valid query",
      sourceCount: 0,
      sources: [],
      status: "complete" as const,
      warning: null
    };
    const activities = projectClientSearchActivity({
      searchRuns: [{
        artifacts: { invocationId: "call-2:openai-search", sources: [] },
        query: execution.query,
        status: "complete",
        strategyId: execution.optionId
      }],
      toolCalls: [
        searchToolCall({
          callId: "call-1",
          errorMessage: "search_query_arguments_invalid",
          query: "invalid query",
          status: "error"
        }),
        searchToolCall({
          callId: "call-2",
          query: execution.query,
          searchExecutions: [execution],
          status: "complete"
        })
      ]
    });

    expect(activities.map((activity) => activity.status)).toEqual(["error", "complete"]);
    expect(activities.map((activity) => activity.query)).toEqual(["invalid query", "valid query"]);
  });

  it.each([
    ["search_timeout", "Search did not respond before the time limit."],
    ["search_runtime_not_available", "This Search source was unavailable for this attempt."],
    ["upstream_error_with_private_detail", "This Search source could not complete the attempt."]
  ] as const)("maps legacy failure %s without exposing its raw code", (warning, expected) => {
    const activity = projectSearchRunActivity({
      artifacts: { warning },
      status: "error"
    });

    expect(activity).toMatchObject({ failureReason: expected, status: "error" });
    expect(JSON.stringify(activity)).not.toContain(warning);
  });

  it("drops a normalized historical provider-operation trace above the inspection limit", () => {
    const providerOperations = Array.from({ length: 32 }, (_, ordinal) => ({
      id: `operation-${ordinal}`,
      kind: "search",
      ordinal,
      pattern: null,
      queries: ["q".repeat(512)],
      status: "complete",
      url: null
    }));

    expect(projectSearchRunActivity({
      artifacts: { providerOperations },
      status: "complete"
    })).toMatchObject({ providerOperations: null });
  });
});
