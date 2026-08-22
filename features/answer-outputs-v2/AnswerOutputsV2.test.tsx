import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function memorySourceArtifact(): ThreadArtifactSummary {
  return {
    citations: [],
    memorySources: [{
      actions: ["CORRECT", "FORGET", "NOT_RELEVANT"],
      date: "2026-08-21T05:00:00.000Z",
      memoryRef: "opaque-memory-ref",
      sourceAvailable: true,
      sourceType: "SAVED_MEMORY",
      text: "I prefer concise answers."
    }],
    reasoningText: [],
    sources: []
  };
}

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
          identitySlot={<span>Quarterly analyst</span>}
          knowledgeReference={{ messageId: "message-1", runId: "run-1" }}
          showReasoning
        />
      </KnowledgeCitationViewerProvider>
    );

    expect(screen.getByText("Quarterly analyst")).toBeVisible();
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

  it("renders a quiet Memory source trace without refs, scores, or technical metadata", () => {
    shellFetch.mockReset();
    render(<AnswerOutputsV2 artifact={memorySourceArtifact()} showReasoning={false} />);

    expect(screen.getByRole("heading", { name: "Memory · 1" })).toBeVisible();
    expect(screen.getByText("Saved memory")).toBeVisible();
    expect(screen.getByText("I prefer concise answers.")).toBeVisible();
    expect(screen.getByText("Saved by you")).toBeVisible();
    expect(screen.getByText("Aug 21, 2026")).toBeVisible();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("opaque-memory-ref");
    expect(text).not.toContain("score");
    expect(text).not.toContain("factId");
    expect(text).not.toContain("versionId");
  });

  it("keeps Memory source headings and correction controls unique across answers", () => {
    const { container } = render(
      <>
        <AnswerOutputsV2 artifact={memorySourceArtifact()} showReasoning={false} />
        <AnswerOutputsV2 artifact={memorySourceArtifact()} showReasoning={false} />
      </>
    );

    for (const button of screen.getAllByRole("button", { name: "Correct" })) {
      fireEvent.click(button);
    }

    const ids = Array.from(container.querySelectorAll<HTMLElement>("[id]"))
      .map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const section of screen.getAllByTestId("answer-memory-sources")) {
      const headingId = section.getAttribute("aria-labelledby");
      expect(headingId).toBeTruthy();
      expect(document.getElementById(headingId ?? "")).toBeInstanceOf(HTMLHeadingElement);
    }
    for (const textbox of screen.getAllByRole("textbox", { name: "Correct this statement" })) {
      const helpId = textbox.getAttribute("aria-describedby");
      expect(document.getElementById(helpId ?? "")).toBeInstanceOf(HTMLElement);
    }
  });

  it("supports bounded inline correction and invalidates the exact source ref", async () => {
    shellFetch.mockReset();
    shellFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "COMMITTED" }), { status: 200 })
    );
    render(<AnswerOutputsV2 artifact={memorySourceArtifact()} showReasoning={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Correct" }));
    const textbox = screen.getByRole("textbox", { name: "Correct this statement" });
    fireEvent.change(textbox, { target: { value: "  I prefer brief answers.  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Memory source corrected."));
    const correctionRequest = shellFetch.mock.calls[0]?.[1] as RequestInit;
    expect(shellFetch.mock.calls[0]?.[0]).toBe("/api/me/memory/source-actions");
    expect(JSON.parse(String(correctionRequest.body))).toMatchObject({
      action: "CORRECT",
      memoryRef: "opaque-memory-ref",
      statement: "I prefer brief answers."
    });
    expect(JSON.parse(String(correctionRequest.body)).requestNonce).toMatch(/^[a-f0-9]{48}$/u);
    expect(document.body.textContent).not.toContain("opaque-memory-ref");
    expect(screen.queryByRole("button", { name: "Correct" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Forget" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Not relevant" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open source" })).not.toBeInTheDocument();
    expect(shellFetch).toHaveBeenCalledOnce();
  });

  it("commits Not relevant from a fresh exact source ref", async () => {
    shellFetch.mockReset();
    shellFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "COMMITTED" }), { status: 200 })
    );
    render(<AnswerOutputsV2 artifact={memorySourceArtifact()} showReasoning={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Not relevant" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("not relevant"));
    const feedbackRequest = shellFetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(feedbackRequest.body))).toMatchObject({
      action: "NOT_RELEVANT",
      memoryRef: "opaque-memory-ref"
    });
  });

  it("removes forgotten source text and invalidates every source action", async () => {
    shellFetch.mockReset();
    shellFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "COMMITTED" }), { status: 200 })
    );
    render(<AnswerOutputsV2 artifact={memorySourceArtifact()} showReasoning={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Forget" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("forgotten"));
    expect(screen.queryByText("I prefer concise answers.")).not.toBeInTheDocument();
    expect(screen.getByText("Source unavailable")).toBeVisible();
    expect(screen.getByText("This Memory source is unavailable.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Correct" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Forget" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Not relevant" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open source" })).not.toBeInTheDocument();
  });

  it("keeps OPEN_SOURCE server affordances inert until a safe href is ready", async () => {
    shellFetch.mockReset();
    const href = "/api/me/memory/source-actions/open?memoryRef=opaque-memory-ref";
    shellFetch.mockResolvedValueOnce(new Response(JSON.stringify({ href, status: "READY" }), {
      status: 200
    }));
    const pastChatArtifact = memorySourceArtifact();
    pastChatArtifact.memorySources = [{
      actions: ["CORRECT", "FORGET", "NOT_RELEVANT", "OPEN_SOURCE"],
      date: "2026-08-21T05:00:00.000Z",
      memoryRef: "opaque-memory-ref",
      origin: "Previous discussion",
      sourceAvailable: true,
      sourceType: "PAST_CHAT",
      text: "The earlier discussion chose concise answers."
    }];
    render(<AnswerOutputsV2 artifact={pastChatArtifact} showReasoning={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Open source" }));
    await waitFor(() => expect(screen.getByRole("link", { name: "Open source" })).toHaveAttribute(
      "href",
      href
    ));
    expect(screen.getByRole("link", { name: "Open source" })).toHaveAttribute("rel", "noreferrer");
    expect(document.body.textContent).not.toContain("opaque-memory-ref");
  });

  it("does not show private source text or actions when a source is unavailable", () => {
    const unavailable = memorySourceArtifact();
    unavailable.memorySources = unavailable.memorySources?.map((source) => ({
      actions: [],
      date: source.date,
      sourceAvailable: false,
      sourceType: source.sourceType
    }));
    render(<AnswerOutputsV2 artifact={unavailable} showReasoning={false} />);

    expect(screen.getByText("Source unavailable")).toBeVisible();
    expect(screen.getByText("This Memory source is unavailable.")).toBeVisible();
    expect(screen.queryByText("private text that must stay hidden")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Correct" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Forget" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Not relevant" })).not.toBeInTheDocument();
  });

  it("shows a bounded friendly notice when Memory was unavailable for this response", () => {
    render(<AnswerOutputsV2 artifact={{
      citations: [],
      memoryStatus: "UNAVAILABLE",
      reasoningText: [],
      sources: []
    }} showReasoning={false} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Memory was unavailable for this response."
    );
    expect(screen.getByTestId("memory-unavailable-status")).not.toHaveTextContent(
      /FAILED_SAFE|DEGRADED|error|code/i
    );
  });
});
