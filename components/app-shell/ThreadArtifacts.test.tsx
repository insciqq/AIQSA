import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ThreadArtifactSummary, ThreadSearchActivity } from "./types";
import {
  CitationBlock,
  ContextTruncationBlock,
  ReasoningBlock,
  SearchSummaryBlock,
  ToolActivityBlock
} from "./ThreadArtifacts";

function summary(overrides: Partial<ThreadArtifactSummary> = {}): ThreadArtifactSummary {
  return {
    citationCount: 0,
    citations: [],
    reasoningCount: 0,
    reasoningText: [],
    searchCount: 0,
    searchStrategy: null,
    toolCallCount: 0,
    toolCalls: [],
    ...overrides
  };
}

function searchActivity(overrides: Partial<ThreadSearchActivity> = {}): ThreadSearchActivity {
  return {
    displayName: "OpenAI Search",
    providerOperations: [],
    providerOperationsTruncated: false,
    query: null,
    sourceCount: 0,
    sources: [],
    status: "complete",
    ...overrides
  };
}

describe("ThreadArtifacts", () => {
  it("renders one calm, default-collapsed Search row with friendly facts", () => {
    render(
      <SearchSummaryBlock
        summary={summary({
          citationCount: 2,
          searchActivity: [searchActivity({ sourceCount: 3 })],
          searchCount: 1,
          searchStrategy: "perplexity-tool-search"
        })}
      />
    );

    const trigger = screen.getByRole("button", { name: /Search OpenAI Search.*Completed.*3 sources.*2 citations/i });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("thread-search-summary")).toHaveClass(
      "border-trace-subtle",
      "text-ink-secondary"
    );
    expect(trigger).toHaveClass("hover:bg-control-hover", "focus-visible:ring-focus");
  });

  it("shows honest active search progress without replacing provider context", () => {
    render(
      <SearchSummaryBlock
        active
        summary={summary({
          citationCount: 2,
          searchActivity: [searchActivity({ status: "running" })],
          searchCount: 1,
          searchStrategy: "openai-native-web-search"
        })}
      />
    );

    const trigger = screen.getByRole("button", { name: /Search OpenAI Search.*Searching/i });
    expect(trigger).toHaveTextContent("OpenAI Search");
    expect(trigger).toHaveTextContent("2 citations");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it.each([
    {
      label: "completed and cancelled",
      summary: "1 of 2 completed",
      statuses: ["complete", "cancelled"] as const
    },
    {
      label: "failed and cancelled",
      summary: "0 of 2 completed",
      statuses: ["error", "cancelled"] as const
    },
    {
      label: "completed, failed, and cancelled",
      summary: "1 of 3 completed",
      statuses: ["complete", "error", "cancelled"] as const
    }
  ])("reports exact completed-attempt progress for $label outcomes", ({ statuses, summary: expectedSummary }) => {
    render(
      <SearchSummaryBlock
        summary={summary({
          searchActivity: statuses.map((status, index) => searchActivity({
            displayName: `Search source ${index + 1}`,
            status
          })),
          searchCount: statuses.length,
          searchStrategy: "client-search-plan"
        })}
      />
    );

    const trigger = screen.getByRole("button", { name: new RegExp(expectedSummary) });
    expect(trigger).not.toHaveTextContent("Status unavailable");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("marks an all-failed multi-attempt Search summary as critical", () => {
    render(
      <SearchSummaryBlock
        summary={summary({
          searchActivity: [
            searchActivity({ displayName: "First Search", status: "error" }),
            searchActivity({ displayName: "Second Search", status: "error" })
          ],
          searchCount: 2,
          searchStrategy: "client-search-plan"
        })}
      />
    );

    const trigger = screen.getByRole("button", { name: /0 of 2 completed/i });
    expect(within(trigger).getByText("· 0 of 2 completed")).toHaveClass("text-critical");
  });

  it("uses the immutable logical Search name instead of exposing its route id", () => {
    render(
      <SearchSummaryBlock
        summary={summary({
          searchActivity: [searchActivity({ displayName: "Company Gateway Search" })],
          searchCount: 1,
          searchDisplayName: "Company Gateway Search",
          searchStrategy: "custom-web-search:connection-1:client"
        })}
      />
    );

    const trigger = screen.getByRole("button", { name: /Search Company Gateway Search/i });
    expect(trigger).toHaveTextContent("Company Gateway Search");
    expect(trigger).not.toHaveTextContent("custom-web-search");
  });

  it("keeps every Search attempt independently expandable with friendly failure detail", () => {
    render(
      <SearchSummaryBlock
        summary={summary({
          citationCount: 1,
          citations: [{ index: 1, title: "Answer citation", url: "https://example.com/citation" }],
          searchActivity: [
            searchActivity({
              displayName: "Company Gateway Search",
              providerOperations: [{
                kind: "search",
                ordinal: 0,
                pattern: null,
                queries: ["current evidence"],
                status: "complete",
                url: null
              }],
              query: "current evidence",
              sourceCount: 1,
              sources: [{
                rank: 1,
                snippet: "Normalized source summary",
                title: "Evidence source",
                url: "https://example.com/source"
              }]
            }),
            searchActivity({
              displayName: "Second Search",
              failureReason: "Search reached its output limit before completing.",
              providerOperations: null,
              query: "second query",
              sourceCount: null,
              status: "error"
            })
          ],
          searchCount: 2,
          searchStrategy: "perplexity-tool-search"
        })}
      />
    );

    expect(screen.queryByText("Generated query")).not.toBeInTheDocument();

    const trigger = screen.getByRole("button", { name: /Search Company Gateway Search \+ Second Search/i });
    trigger.focus();
    fireEvent.click(trigger);

    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const details = screen.getByTestId("thread-search-details");
    expect(within(details).getByText("Company Gateway Search")).toBeVisible();
    expect(within(details).getByText("Second Search")).toBeVisible();
    const attempts = within(details).getAllByTestId("thread-search-attempt");
    expect(attempts).toHaveLength(2);
    const firstAttempt = within(attempts[0]!).getByRole("button", {
      name: /Attempt 1 Company Gateway Search Completed.*1 source/i
    });
    const secondAttempt = within(attempts[1]!).getByRole("button", {
      name: /Attempt 2 Second Search Failed/i
    });
    expect(firstAttempt).toHaveAttribute("aria-expanded", "false");
    expect(secondAttempt).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(firstAttempt);
    fireEvent.click(secondAttempt);
    expect(firstAttempt).toHaveAttribute("aria-expanded", "true");
    expect(secondAttempt).toHaveAttribute("aria-expanded", "true");
    expect(within(details).getAllByText("Generated query")).toHaveLength(2);
    expect(within(details).getAllByText("current evidence")).toHaveLength(2);
    expect(within(details).getByText("second query")).toBeVisible();
    expect(within(details).getByRole("link", { name: "Evidence source" })).toHaveAttribute(
      "href",
      "https://example.com/source"
    );
    expect(within(details).getByText("Normalized source summary")).toBeVisible();
    expect(within(details).getByText("Provider operations · 1")).toBeVisible();
    expect(within(details).getByText("Provider operation details are unavailable for this run.")).toBeVisible();
    expect(within(details).getByText("Search reached its output limit before completing.")).toBeVisible();
    expect(within(details).getByRole("link", { name: "[1] Answer citation" })).toBeVisible();
    expect(details).not.toHaveTextContent(/search-provider|search-model|route-|revision-|credential|Request|Response/);

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("thread-search-details")).not.toBeInTheDocument();
  });

  it("keeps historical missing detail explicit", () => {
    render(
      <SearchSummaryBlock
        summary={summary({
          citationCount: 6,
          searchCount: 2,
          searchStrategy: "perplexity-tool-search"
        })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Search Perplexity Search/i }));
    expect(screen.getByText("Detailed Search evidence is unavailable for this run.")).toBeVisible();
  });

  it("renders bounded hosted Search operations without exposing provider payload ids", () => {
    render(
      <SearchSummaryBlock
        summary={summary({
          citationCount: 3,
          searchActivity: [searchActivity({
            providerOperations: [
              {
                kind: "search",
                ordinal: 0,
                pattern: null,
                queries: [],
                status: "complete",
                url: null
              },
              {
                kind: "open_page",
                ordinal: 1,
                pattern: null,
                queries: [],
                status: "complete",
                url: "https://username:password@example.com/private"
              }
            ],
            sourceCount: null
          })],
          searchCount: 1,
          searchStrategy: "openai-native-web-search"
        })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Search OpenAI Search/i }));
    expect(screen.getByText(/Web search/)).toBeVisible();
    expect(screen.getByText("Provider did not report the internal query.")).toBeVisible();
    expect(document.body).not.toHaveTextContent(/ws_123|web_search_call|username:password/);
  });

  it("renders normalized hosted sources", () => {
    render(
      <SearchSummaryBlock
        summary={summary({
          citationCount: 1,
          searchActivity: [searchActivity({
            sourceCount: 1,
            sources: [{ rank: 1, title: "Example source", url: "https://example.com/source" }]
          })],
          searchCount: 1,
          searchStrategy: "openai-native-web-search"
        })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Search OpenAI Search/i }));
    expect(screen.getByRole("link", { name: "Example source" })).toHaveAttribute(
      "href",
      "https://example.com/source"
    );
  });

  it("does not mislabel a custom Responses source as OpenAI in hosted call history", () => {
    render(
      <SearchSummaryBlock
        summary={summary({
          searchCount: 1,
          searchActivity: [searchActivity({
            displayName: "Company Gateway Search",
            providerOperations: [],
            sourceCount: null
          })],
          searchDisplayName: "Company Gateway Search",
          searchStrategy: "custom-web-search:connection-1"
        })}
      />
    );

    const trigger = screen.getByRole("button", { name: /Search Company Gateway Search/i });
    expect(trigger).toHaveTextContent("Company Gateway Search");
    fireEvent.click(trigger);
    expect(within(screen.getByTestId("thread-search-details")).getByText("Company Gateway Search")).toBeVisible();
    expect(screen.getByText("The provider reported no detailed web operations.")).toBeVisible();
    expect(document.body).not.toHaveTextContent("OpenAI web search call");
    expect(document.body).not.toHaveTextContent("OpenAI returned");
  });

  it("keeps citation and reasoning details collapsed until explicitly requested", () => {
    const baseSummary = summary({
      citationCount: 1,
      reasoningCount: 1,
      reasoningText: []
    });

    render(
      <>
        <CitationBlock summary={baseSummary} />
        <ReasoningBlock summary={baseSummary} />
      </>
    );

    const citations = screen.getByRole("button", { name: /Citations 1/i });
    const reasoning = screen.getByRole("button", { name: /Reasoning 1/i });
    expect(citations).toHaveAttribute("aria-expanded", "false");
    expect(reasoning).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("No citation text captured for this run.")).not.toBeInTheDocument();
    expect(screen.queryByText("No reasoning text captured for this run.")).not.toBeInTheDocument();

    citations.focus();
    fireEvent.click(citations);
    expect(citations).toHaveFocus();
    expect(citations).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("No citation text captured for this run.")).toBeVisible();

    reasoning.focus();
    fireEvent.click(reasoning);
    expect(reasoning).toHaveFocus();
    expect(reasoning).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("No reasoning text captured for this run.")).toBeVisible();
  });

  it("discloses captured citations and reasoning and collapses them again", () => {
    render(
      <>
        <CitationBlock
          summary={summary({
            citationCount: 1,
            citations: [{ index: 1, title: "Source title", url: "https://example.com/source" }]
          })}
        />
        <ReasoningBlock
          summary={summary({
            reasoningCount: 2,
            reasoningText: ["First reasoning block", "Second reasoning block"]
          })}
        />
      </>
    );

    const citations = screen.getByRole("button", { name: /Citations 1/i });
    const reasoning = screen.getByRole("button", { name: /Reasoning 2/i });
    fireEvent.click(citations);
    fireEvent.click(reasoning);

    expect(screen.getByRole("link", { name: "[1] Source title" })).toBeVisible();
    expect(screen.getByText(/First reasoning block/)).toHaveTextContent(
      "First reasoning block Second reasoning block"
    );

    fireEvent.click(citations);
    fireEvent.click(reasoning);
    expect(screen.queryByRole("link", { name: "[1] Source title" })).not.toBeInTheDocument();
    expect(screen.queryByText(/First reasoning block/)).not.toBeInTheDocument();
  });

  it("uses singular and plural context-truncation wording", () => {
    const { rerender } = render(
      <ContextTruncationBlock
        summary={summary({
          contextTruncation: { approxDroppedTokens: 0, droppedMessages: 1 }
        })}
      />
    );

    const notice = screen.getByRole("complementary", { name: "Context trimmed" });
    expect(notice).toHaveClass("border-caution/45", "text-ink-secondary");
    expect(notice).not.toHaveClass("rounded-control");
    expect(notice).toHaveTextContent("The oldest message was not sent because the context window was full");
    expect(notice).not.toHaveTextContent("messages were");

    rerender(
      <ContextTruncationBlock
        summary={summary({
          contextTruncation: { approxDroppedTokens: 321, droppedMessages: 4 }
        })}
      />
    );

    expect(screen.getByRole("complementary", { name: "Context trimmed" })).toHaveTextContent(
      "The oldest 4 messages were not sent because the context window was full · ~321 tokens"
    );
  });

  it("contains a long generated query inside the local disclosure surface", () => {
    const longToken = "generated-query-".repeat(80);
    render(
      <SearchSummaryBlock
        summary={summary({
          searchCount: 1,
          searchActivity: [searchActivity({ query: longToken })]
        })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Search OpenAI Search/i }));
    expect(screen.getByText(longToken)).toHaveClass("break-words", "[overflow-wrap:anywhere]");
  });

  it("renders unsafe citation URLs as inert text and contains long source content", () => {
    const longTitle = `Long source ${"unbroken".repeat(80)}`;
    const longSnippet = "citation-snippet-".repeat(80);
    render(
      <CitationBlock
        summary={summary({
          citationCount: 2,
          citations: [
            {
              index: 1,
              title: "Unsafe",
              url: "javascript:alert(1)"
            },
            {
              index: 2,
              snippet: longSnippet,
              title: longTitle,
              url: `https://example.com/${"path".repeat(100)}`
            }
          ]
        })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Citations 2/i }));
    expect(screen.queryByRole("link", { name: "[1] Unsafe" })).not.toBeInTheDocument();
    expect(screen.getByText("[1] Unsafe")).toBeVisible();
    const safeLink = screen.getByRole("link", { name: `[2] ${longTitle}` });
    expect(safeLink).toHaveAttribute("href", `https://example.com/${"path".repeat(100)}`);
    expect(safeLink).toHaveClass("break-words", "[overflow-wrap:anywhere]");
    expect(safeLink.closest("li")).toHaveClass("min-w-0");
    expect(screen.getByText(longSnippet)).toHaveClass(
      "break-words",
      "text-ink-secondary",
      "[overflow-wrap:anywhere]"
    );
  });

  it("discloses parallel MCP calls with status, timing, and safe previews", () => {
    render(
      <ToolActivityBlock
        summary={summary({
          toolCallCount: 3,
          toolCalls: [
            {
              argumentsPreview: { apiKey: "[redacted]", text: "remember this" },
              callId: "call-remember",
              capability: "mcp",
              credentialSources: ["personal"],
              durationMs: 85,
              errorMessage: null,
              externalAccountLabel: "Personal memory",
              ordinal: 0,
              resultPreview: { content: [{ text: "saved", type: "text" }] },
              round: 1,
              serverName: "Mem0",
              status: "complete",
              toolName: "remember"
            },
            {
              argumentsPreview: { page: "Roadmap" },
              callId: "call-notion",
              capability: "mcp",
              credentialSources: ["oauth"],
              durationMs: 1_250,
              errorMessage: "Notion request failed",
              externalAccountLabel: "Team Notion",
              ordinal: 1,
              resultPreview: { content: [{ text: "request failed", type: "text" }] },
              round: 1,
              serverName: "Notion",
              status: "error",
              toolName: "search"
            },
            {
              argumentsPreview: { query: "follow-up" },
              callId: "call-running",
              capability: "mcp",
              credentialSources: ["shared"],
              durationMs: null,
              errorMessage: null,
              externalAccountLabel: null,
              ordinal: 0,
              resultPreview: null,
              round: 2,
              serverName: "Todoist",
              status: "running",
              toolName: "find_tasks"
            }
          ]
        })}
      />
    );

    const trigger = screen.getByRole("button", { name: /Running 1 tool/i });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveTextContent("1 failed");
    expect(trigger).toHaveTextContent("Mem0, Notion, Todoist");
    expect(screen.queryByText("Round 1")).not.toBeInTheDocument();

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Round 1")).toBeVisible();
    expect(screen.getByText("2 parallel calls")).toBeVisible();
    expect(screen.getByText("Round 2")).toBeVisible();
    expect(screen.getByText("Mem0 / remember")).toBeVisible();
    expect(screen.getByText("Completed")).toBeVisible();
    expect(screen.getByText("85 ms")).toBeVisible();
    expect(screen.getByText("1.3 s")).toBeVisible();

    fireEvent.click(screen.getByText("Mem0 / remember").closest("summary")!);
    expect(screen.getByText("Account: Personal memory")).toBeVisible();
    expect(screen.getByText("Credentials: personal")).toBeVisible();
    expect(screen.getByText(/remember this/)).toBeVisible();
    expect(screen.getByText(/saved/)).toBeVisible();
    expect(screen.getByTestId("thread-tool-activity-details")).not.toHaveTextContent(
      "sk-private"
    );
  });

  it("does not render Search calls inside generic tool activity", () => {
    render(
      <>
        <SearchSummaryBlock
          summary={summary({
            searchActivity: [searchActivity({ query: "latest news in Moscow" })],
            searchCount: 1
          })}
        />
        <ToolActivityBlock
          summary={summary({
            toolCallCount: 1,
            toolCalls: [{
              argumentsPreview: { query: "latest news in Moscow" },
              callId: "search-call-1",
              capability: "web_search",
              credentialSources: [],
              durationMs: 100,
              errorMessage: null,
              externalAccountLabel: null,
              ordinal: 0,
              resultPreview: null,
              round: 1,
              serverName: null,
              status: "complete",
              toolName: "search_selected_engines"
            }]
          })}
        />
      </>
    );

    expect(screen.getByTestId("thread-search-summary")).toBeVisible();
    expect(screen.queryByTestId("thread-tool-activity")).not.toBeInTheDocument();
    expect(screen.queryByText("search_selected_engines")).not.toBeInTheDocument();
  });
});
