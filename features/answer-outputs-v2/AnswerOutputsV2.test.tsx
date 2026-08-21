import { fireEvent, render, screen } from "@testing-library/react";
import type { ThreadArtifactSummary } from "@/lib/contracts/chats";
import { KnowledgeCitationViewerProvider } from "@/features/citations-v2/KnowledgeCitationViewer";
import { describe, expect, it, vi } from "vitest";
import { AnswerOutputsV2 } from "./AnswerOutputsV2";

const shellFetch = vi.hoisted(() => vi.fn());

vi.mock("@/components/app-shell/shellApi", () => ({ shellFetch }));

const artifact: ThreadArtifactSummary = {
  citations: [{
    index: 1,
    source: "Research notes",
    title: "Cross-language retrieval",
    url: "https://example.com/retrieval"
  }],
  knowledgeCitations: [{
    handle: "K1.1"
  }],
  reasoningText: ["**Compared sources** without exposing the query."],
  sources: [{
    rank: 1,
    snippet: "Bounded safe snippet.",
    title: "Cross-language retrieval",
    url: "https://example.com/retrieval"
  }]
};

describe("answer outputs v2", () => {
  it("shows only safe Sources, reauthorized Project evidence, Reasoning, and identity", async () => {
    shellFetch.mockResolvedValue(new Response(JSON.stringify({
      citation: {
        blocks: [],
        excerpt: "The accepted Project passage.",
        excerptTruncated: false,
        handle: "K1.1",
        headingPath: ["Retrieval policy"],
        locator: { boundingBoxes: [], pageEnd: 18, pageStart: 18 },
        originalKind: null,
        source: {
          baseName: "Engineering handbook",
          fileName: "retrieval-policy.pdf",
          mimeType: "application/pdf",
          name: "Retrieval policy",
          statuses: [],
          versionNumber: 3
        },
        state: "available",
        visual: null,
        workbook: null
      }
    }), { status: 200 }));
    render(
      <KnowledgeCitationViewerProvider>
        <AnswerOutputsV2
          artifact={artifact}
          identitySlot={<span>Quarterly analyst · revision 3</span>}
          knowledgeReference={{ messageId: "message-1", runId: "run-1" }}
          showReasoning
        />
      </KnowledgeCitationViewerProvider>
    );

    expect(screen.getByText("Quarterly analyst · revision 3")).toBeVisible();
    fireEvent.click(screen.getByText("Sources"));
    expect(screen.getByRole("link", { name: "Cross-language retrieval" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Knowledge source [K1.1]" }));
    expect(await screen.findByText("The accepted Project passage.")).toBeVisible();
    expect(shellFetch).toHaveBeenCalledWith(
      "/api/runs/run-1/messages/message-1/citations/K1.1",
      expect.objectContaining({ method: "GET" })
    );
    expect(screen.getByText(/retrieval-policy\.pdf · version 3/)).toBeVisible();
    expect(screen.getByTestId("answer-reasoning").textContent).not.toContain("**");

    const text = document.body.textContent ?? "";
    expect(text).not.toContain("private generated query");
    expect(text).not.toContain("Private Search route");
    expect(text).not.toContain("private-route-id");
    expect(text).not.toContain("private-call-id");
    expect(text).not.toContain("private-argument");
    expect(text).not.toContain("private-result");
    expect(text).not.toMatch(/invocation|threshold|candidate|Run details|Answer evidence/iu);
  });

  it("fails closed when a Project citation is no longer authorized", async () => {
    shellFetch.mockResolvedValue(new Response(JSON.stringify({
      error: "knowledge_reference_not_available"
    }), { status: 404 }));
    render(
      <KnowledgeCitationViewerProvider>
        <AnswerOutputsV2
          artifact={artifact}
          knowledgeReference={{ messageId: "message-1", runId: "run-1" }}
          showReasoning={false}
        />
      </KnowledgeCitationViewerProvider>
    );
    fireEvent.click(screen.getByText("Sources"));
    fireEvent.click(screen.getByRole("button", { name: "Knowledge source [K1.1]" }));
    expect((await screen.findAllByText("Source unavailable"))[0]).toBeVisible();
  });

  it("renders no placeholder when there is no output", () => {
    const { container } = render(
      <AnswerOutputsV2 artifact={null} showReasoning={false} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("distinguishes insufficient evidence and a partially ready selected scope", () => {
    render(
      <AnswerOutputsV2
        artifact={{
          citations: [],
          knowledgeCitations: [],
          knowledgeState: {
            answer: "insufficient_evidence",
            scope: "partial_sources_ready"
          },
          reasoningText: [],
          sources: []
        }}
        showReasoning={false}
      />
    );

    const state = screen.getByRole("status");
    expect(state).toHaveAttribute("data-answer", "insufficient_evidence");
    expect(state).toHaveAttribute("data-scope", "partial_sources_ready");
    expect(state).toHaveTextContent(/ready documents did not contain enough evidence/iu);
    expect(state).toHaveTextContent(/still processing/iu);
  });
});
