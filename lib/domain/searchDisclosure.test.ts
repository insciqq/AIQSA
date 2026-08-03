import { describe, expect, it } from "vitest";
import {
  projectHostedSearchActivity,
  projectSearchRunActivity
} from "./searchDisclosure";

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
