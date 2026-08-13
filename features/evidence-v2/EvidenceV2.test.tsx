import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ThreadArtifactSummary, ThreadToolActivity } from "@/lib/contracts/chats";
import {
  CitationMarkerV2,
  EvidenceRowV2,
  SearchEvidenceV2,
  ToolApprovalCardV2,
  ToolEvidenceV2
} from "./EvidenceV2";

const emptySummary: ThreadArtifactSummary = {
  citationCount: 0,
  citations: [],
  reasoningCount: 0,
  reasoningText: [],
  searchCount: 0,
  searchStrategy: null,
  toolCallCount: 0,
  toolCalls: []
};

describe("Evidence v2", () => {
  it("keeps the terminal row to non-zero facts plus Run details", () => {
    const onOpenRunDetails = vi.fn();
    const { rerender } = render(
      <EvidenceRowV2
        onOpenRunDetails={onOpenRunDetails}
        summary={{ fileCount: 0, hasUsage: true, sourceCount: 0, toolCallCount: 0 }}
      />
    );
    expect(screen.getByTestId("evidence-row")).toHaveTextContent("Run details");
    expect(screen.queryByText(/Sources/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/Tools/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/Files/u)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run details, usage available" })).toBeVisible();

    rerender(
      <EvidenceRowV2
        onOpenRunDetails={onOpenRunDetails}
        summary={{ fileCount: 2, hasUsage: false, sourceCount: 3, toolCallCount: 1 }}
      />
    );
    expect(screen.getAllByRole("button")).toHaveLength(4);
    expect(screen.getByText("Sources 3")).toBeVisible();
    expect(screen.getByText("Tools 1")).toBeVisible();
    expect(screen.getByText("Files 2")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Run details" }));
    expect(onOpenRunDetails).toHaveBeenCalledOnce();
  });

  it("shows empty and failed Search attempts truthfully and keeps unsafe links inert", () => {
    const summary: ThreadArtifactSummary = {
      ...emptySummary,
      citationCount: 1,
      citations: [{ index: 1, title: "Unsafe citation", url: "javascript:alert(1)" }],
      searchActivity: [
        {
          displayName: "Empty source",
          providerOperations: [],
          providerOperationsTruncated: false,
          query: "missing evidence",
          sourceCount: 0,
          sources: [],
          status: "complete"
        },
        {
          displayName: "Failed source",
          failureReason: "Timed out without a result.",
          providerOperations: null,
          providerOperationsTruncated: false,
          query: null,
          sourceCount: 0,
          sources: [],
          status: "error"
        }
      ],
      searchCount: 2
    };
    render(<SearchEvidenceV2 onOpenChange={() => undefined} open summary={summary} />);

    expect(screen.getByRole("button", { name: "Search, Partial, 2 attempts" })).toBeVisible();
    expect(screen.getAllByText("No sources were returned by this attempt.")).toHaveLength(2);
    expect(screen.getByText("Timed out without a result.")).toBeVisible();
    expect(screen.getByTestId("unsafe-citation-title").closest("a")).toBeNull();
    expect(document.querySelector("a[href^='javascript:']")).toBeNull();
  });

  it("keeps bounded Gemini suggestions in the Search evidence disclosure", async () => {
    render(
      <SearchEvidenceV2
        onOpenChange={() => undefined}
        open
        summary={{
          ...emptySummary,
          groundingDisplay: {
            callCount: 1,
            provider: "gemini",
            queryCount: 1,
            suggestionsHtml: '<a href="https://google.com/search?q=aiqsa">Continue on Google</a>'
          }
        }}
      />
    );

    expect(screen.getByRole("button", { name: "Search, Complete, 0 attempts" })).toBeVisible();
    expect(screen.getByRole("complementary", { name: "Google Search suggestions" }))
      .toBeVisible();
    await screen.findByTestId("gemini-search-suggestions-host");
  });

  it("opens citations through an explicit keyboard-safe control", () => {
    const onActivate = vi.fn();
    render(<CitationMarkerV2 index={2} onActivate={onActivate} />);
    const marker = screen.getByRole("button", { name: "Open source 2" });
    marker.focus();
    fireEvent.click(marker);
    expect(onActivate).toHaveBeenCalledWith(2);
  });

  it("renders tool previews as bounded untrusted text without private call ids", () => {
    const toolCall: ThreadToolActivity = {
      argumentsPreview: { query: "safe" },
      callId: "private-call-id",
      capability: "mcp",
      credentialSources: ["shared"],
      durationMs: null,
      errorMessage: null,
      externalAccountLabel: null,
      ordinal: 0,
      resultPreview: { html: "<img src=x onerror=alert(1)>" },
      round: 1,
      serverName: "Archive",
      status: "complete",
      toolName: "lookup"
    };
    render(<ToolEvidenceV2 open toolCalls={[toolCall]} />);

    expect(screen.queryByText("private-call-id")).not.toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/u)).toBeInTheDocument();
  });

  it("keeps approval arguments bounded and exposes explicit Allow/Reject actions", () => {
    const onAllow = vi.fn();
    const onReject = vi.fn();
    render(
      <ToolApprovalCardV2
        onAllow={onAllow}
        onReject={onReject}
        redactedArgumentsPreview={{ payload: "x".repeat(10_000) }}
        serverName="Archive"
        status="pending"
        toolName="lookup"
      />
    );

    const preview = document.querySelector(".v2-tool-approval pre");
    expect(preview?.textContent?.length).toBeLessThanOrEqual(4_098);
    expect(preview).toHaveTextContent("…");
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onAllow).toHaveBeenCalledOnce();
    expect(onReject).toHaveBeenCalledOnce();
  });
});
