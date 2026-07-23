import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ThreadArtifactSummary } from "./types";
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

describe("ThreadArtifacts", () => {
  it("uses readable search call wording", () => {
    render(
      <SearchSummaryBlock
        summary={summary({
          searchCount: 3,
          searchStrategy: "perplexity-tool-search"
        })}
      />
    );

    const trigger = screen.getByRole("button", { name: /3 search calls/i });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveTextContent("Perplexity tool");
  });

  it("shows honest active search progress without replacing provider context", () => {
    render(
      <SearchSummaryBlock
        active
        summary={summary({
          citationCount: 2,
          searchCount: 1,
          searchStrategy: "openai-native-web-search"
        })}
      />
    );

    const trigger = screen.getByRole("button", { name: /Searching/i });
    expect(trigger).toHaveTextContent("OpenAI web_search");
    expect(trigger).toHaveTextContent("2 citations");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("expands multiple search records and keeps focus on the disclosure", () => {
    render(
      <SearchSummaryBlock
        summary={summary({
          searchCount: 2,
          searchDetails: [
            {
              requestPreview: {
                body: {
                  messages: [{ content: "Question:\nasd" }]
                }
              },
              responsePreview: {
                text: "Search answer"
              },
              status: "complete",
              strategyId: "perplexity-tool-search"
            },
            {
              modelId: "search-model",
              provider: "search-provider",
              requestPreview: { query: "second query" },
              responsePreview: { text: "Second search answer" },
              status: "complete",
              strategyId: "perplexity-tool-search"
            }
          ],
          searchStrategy: "perplexity-tool-search"
        })}
      />
    );

    expect(screen.queryByText("Request")).not.toBeInTheDocument();

    const trigger = screen.getByRole("button", { name: /2 search calls/i });
    trigger.focus();
    fireEvent.click(trigger);

    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const details = screen.getByTestId("thread-search-details");
    expect(within(details).getByText("Search 1")).toBeVisible();
    expect(within(details).getByText("Search 2")).toBeVisible();
    expect(within(details).getByText("search-provider / search-model")).toBeVisible();
    expect(within(details).getAllByText("Request")).toHaveLength(2);
    expect(within(details).getAllByText("Response")).toHaveLength(2);
    expect(screen.getByText(/Question/)).toBeVisible();
    expect(screen.getByText(/Search answer/)).toBeVisible();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("thread-search-details")).not.toBeInTheDocument();
  });

  it("expands search summaries even when request and response previews were not captured", () => {
    render(
      <SearchSummaryBlock
        summary={summary({
          citationCount: 6,
          searchCount: 2,
          searchStrategy: "perplexity-tool-search"
        })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /2 search calls/i }));
    expect(screen.getByText("No search/tool request or response preview captured for this run.")).toBeVisible();
  });

  it("renders captured native search call records when request and response previews are unavailable", () => {
    render(
      <SearchSummaryBlock
        summary={summary({
          citationCount: 3,
          searchCount: 1,
          searchDetails: [
            {
              callPreview: {
                action: {
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
        })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /1 search call/i }));
    expect(screen.getByText("OpenAI web search call")).toBeVisible();
    expect(screen.getByText(/metadata only/)).toBeVisible();
    expect(screen.getByText(/web_search_call/)).toBeVisible();
    expect(screen.queryByText("No search/tool request or response preview captured for this run.")).not.toBeInTheDocument();
  });

  it("renders OpenAI web search call action details when provider includes sources", () => {
    render(
      <SearchSummaryBlock
        summary={summary({
          citationCount: 1,
          searchCount: 1,
          searchDetails: [
            {
              callPreview: {
                action: {
                  sources: [
                    {
                      title: "Example source",
                      url: "https://example.com/source"
                    }
                  ],
                  type: "search"
                },
                id: "ws_456",
                status: "completed",
                type: "web_search_call"
              },
              status: "completed",
              strategyId: "openai-native-web-search"
            }
          ],
          searchStrategy: "openai-native-web-search"
        })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /1 search call/i }));
    expect(screen.getByText("OpenAI web search call")).toBeVisible();
    expect(screen.getByText(/Example source/)).toBeVisible();
    expect(screen.queryByText(/metadata only/)).not.toBeInTheDocument();
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

  it("contains long search previews inside the local disclosure surface", () => {
    const longToken = "request-preview-".repeat(80);
    render(
      <SearchSummaryBlock
        summary={summary({
          searchCount: 1,
          searchDetails: [
            {
              requestPreview: { query: longToken },
              responsePreview: { text: longToken },
              status: "complete"
            }
          ]
        })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /1 search call/i }));
    const previews = screen.getByTestId("thread-search-details").querySelectorAll("pre");
    expect(previews).toHaveLength(2);
    for (const preview of previews) {
      expect(preview).toHaveClass("max-w-full", "overflow-auto", "break-words", "[overflow-wrap:anywhere]");
    }
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
      "text-content-secondary",
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
});
