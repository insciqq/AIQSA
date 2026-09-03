import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ThreadArtifactSummary } from "@/lib/contracts/chats";
import type { MemoryAnswerSource } from "@/lib/contracts/memoryClient";
import { KnowledgeCitationViewerProvider } from "@/features/citations-v2/KnowledgeCitationViewer";
import { RunAnswerV2 } from "@/features/run-lifecycle-v2/RunLifecycleV2";
import { describe, expect, it, vi } from "vitest";
import { AnswerOutputsV2 } from "./AnswerOutputsV2";
import { AnswerProcessV2 } from "./AnswerProcessV2";

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
  }],
  workDurationMs: 12_400
};

function memorySource(): MemoryAnswerSource {
  return {
    actions: ["CORRECT", "FORGET", "NOT_RELEVANT"],
    date: "2026-08-21T05:00:00.000Z",
    memoryRef: "opaque-memory-ref",
    sourceAvailable: true,
    sourceType: "SAVED_MEMORY",
    text: "I prefer concise answers."
  };
}

/** The process fold is collapsed by default; tests open it first. */
function openProcess() {
  for (const fold of screen.getAllByTestId("tool-activity-disclosure")) {
    (fold as HTMLDetailsElement).open = true;
  }
}

/** Memory row verbs wait behind the row's "⋯" menu. */
function pickMemoryAction(name: string, index = 0) {
  fireEvent.click(screen.getAllByRole("button", { name: "Memory actions" })[index]!);
  fireEvent.click(screen.getByRole("menuitem", { name }));
}

describe("answer outputs v2", () => {
  it("shows safe Sources under the actions row, reauthorized Project evidence, and Thinking above", async () => {
    shellFetch.mockResolvedValue(new Response(JSON.stringify({
      citation: {
        blocks: [],
        excerpt: "The accepted Project passage.",
        excerptTruncated: false,
        handle: "K1.1",
        headingPath: ["Retrieval policy"],
        libraryAvailable: false,
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
        <RunAnswerV2
          actions={{ onCopy: () => undefined, onRegenerate: () => undefined }}
          artifact={artifact}
          content="Answer [K1.1]"
          knowledgeReference={{ messageId: "message-1", runId: "run-1" }}
          leadingSlot={<span>Quarterly analyst</span>}
          presentation={{ kind: "complete", runId: "run-1" }}
        />
      </KnowledgeCitationViewerProvider>
    );

    expect(screen.getByText("Quarterly analyst")).toBeVisible();
    // The process line is a human phrase, never a count of tool calls.
    expect(screen.getByTestId("tool-activity-disclosure")).toHaveTextContent("Thought for 12s");
    expect(screen.queryByTestId("answer-sources")).not.toBeInTheDocument();
    const toolbar = screen.getByRole("toolbar", { name: "Answer actions" });
    const toggle = screen.getByTestId("answer-sources-toggle");
    expect(toolbar).toContainElement(toggle);
    expect(toggle).toHaveAccessibleName("Sources, 2 items");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls", screen.getByTestId("answer-sources").id);
    expect(screen.getByRole("link", { name: "Cross-language retrieval" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Knowledge document [K1.1]" }));
    expect(await screen.findByText("The accepted Project passage.")).toBeVisible();
    expect(shellFetch).toHaveBeenCalledWith(
      "/api/runs/run-1/messages/message-1/citations/K1.1",
      expect.objectContaining({ method: "GET" })
    );
    expect(screen.getByText("retrieval-policy.pdf · Engineering handbook")).toBeVisible();
    expect(screen.queryByText(/version 3/iu)).not.toBeInTheDocument();
    openProcess();
    expect(screen.getByTestId("answer-reasoning")).toHaveTextContent("Thinking");
    expect(screen.getByTestId("answer-reasoning").textContent).not.toContain("**");

    const text = document.body.textContent ?? "";
    expect(text).not.toContain("private generated query");
    expect(text).not.toContain("Private Search route");
    expect(text).not.toContain("private-route-id");
    expect(text).not.toContain("private-call-id");
    expect(text).not.toContain("private-argument");
    expect(text).not.toContain("private-result");
    expect(text).not.toMatch(/invocation|threshold|candidate|Run details|Answer evidence|tool call/iu);
  });

  it("fails closed when a Project citation is no longer authorized", async () => {
    shellFetch.mockResolvedValue(new Response(JSON.stringify({
      error: "knowledge_reference_not_available"
    }), { status: 404 }));
    render(
      <KnowledgeCitationViewerProvider>
        <RunAnswerV2
          artifact={artifact}
          content="Answer"
          knowledgeReference={{ messageId: "message-1", runId: "run-1" }}
          presentation={{ kind: "complete", runId: "run-1" }}
          showReasoning={false}
        />
      </KnowledgeCitationViewerProvider>
    );
    // Reasoning hidden by preference leaves nothing for the process line.
    expect(screen.queryByTestId("tool-activity-disclosure")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("answer-sources-toggle"));
    fireEvent.click(screen.getByRole("button", { name: "Knowledge document [K1.1]" }));
    expect((await screen.findAllByText("Document unavailable"))[0]).toBeVisible();
  });

  it("renders no placeholder when there is no output", () => {
    const { container } = render(<AnswerOutputsV2 artifact={null} />);
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
      />
    );

    const state = screen.getByRole("status");
    expect(state).toHaveAttribute("data-answer", "insufficient_evidence");
    expect(state).toHaveAttribute("data-scope", "partial_sources_ready");
    expect(state).toHaveTextContent(/ready documents did not contain enough evidence/iu);
    expect(state).toHaveTextContent(/still processing/iu);
  });

  it("presents a failed Knowledge retrieval as a technical availability issue", () => {
    render(
      <AnswerProcessV2
        toolActivity={{
          calls: [{ round: 1, status: "error", toolName: "search_knowledge" }]
        }}
      />
    );
    openProcess();

    expect(screen.getByText("Knowledge search unavailable")).toBeVisible();
    expect(screen.getByText(/Failed · round 1/iu)).toBeVisible();
    expect(document.body.textContent).not.toContain("search_knowledge");
  });

  it("renders a quiet Memory source row without refs, scores, or technical metadata", () => {
    shellFetch.mockReset();
    render(<AnswerProcessV2 memorySources={[memorySource()]} />);
    expect(screen.getByTestId("tool-activity-disclosure")).toHaveTextContent("Used 1 memory");
    openProcess();

    expect(screen.getByRole("heading", { name: "Memory" })).toBeVisible();
    expect(screen.getByText("Saved memory")).toBeInTheDocument();
    expect(screen.getByText("I prefer concise answers.")).toBeVisible();
    expect(screen.getByText("Saved by you")).toBeVisible();
    expect(screen.getByText("Aug 21, 2026")).toBeVisible();
    // The verbs wait behind one "⋯" per row, Forget last and destructive.
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Memory actions" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Correct",
      "Not relevant",
      "Forget"
    ]);
    expect(screen.getByRole("menuitem", { name: "Forget" })).toHaveAttribute("data-tone", "destructive");
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("opaque-memory-ref");
    expect(text).not.toContain("score");
    expect(text).not.toContain("factId");
    expect(text).not.toContain("versionId");
  });

  it("keeps Memory source headings and correction controls unique across answers", () => {
    const { container } = render(
      <>
        <AnswerProcessV2 memorySources={[memorySource()]} />
        <AnswerProcessV2 memorySources={[memorySource()]} />
      </>
    );
    openProcess();

    pickMemoryAction("Correct", 0);
    pickMemoryAction("Correct", 0);

    const ids = Array.from(container.querySelectorAll<HTMLElement>("[id]"))
      .map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const section of screen.getAllByTestId("answer-memory-sources")) {
      const headingId = section.getAttribute("aria-labelledby");
      expect(headingId).toBeTruthy();
      expect(document.getElementById(headingId ?? "")).toBeInstanceOf(HTMLHeadingElement);
    }
    expect(screen.getAllByRole("textbox", { name: "Correct this statement" })).toHaveLength(2);
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
    render(<AnswerProcessV2 memorySources={[memorySource()]} />);
    openProcess();

    pickMemoryAction("Correct");
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
    expect(screen.getByText("I prefer brief answers.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Memory actions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open source" })).not.toBeInTheDocument();
    expect(shellFetch).toHaveBeenCalledOnce();
  });

  it("commits Not relevant from a fresh exact source ref", async () => {
    shellFetch.mockReset();
    shellFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "COMMITTED" }), { status: 200 })
    );
    render(<AnswerProcessV2 memorySources={[memorySource()]} />);
    openProcess();

    pickMemoryAction("Not relevant");
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
    render(<AnswerProcessV2 memorySources={[memorySource()]} />);
    openProcess();

    pickMemoryAction("Forget");

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("forgotten"));
    expect(screen.queryByText("I prefer concise answers.")).not.toBeInTheDocument();
    expect(screen.getByText("Source unavailable")).toBeVisible();
    expect(screen.getByText("This Memory source is unavailable.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Memory actions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open source" })).not.toBeInTheDocument();
  });

  it("keeps OPEN_SOURCE server affordances inert until a safe href is ready", async () => {
    shellFetch.mockReset();
    const href = "/api/me/memory/source-actions/open?memoryRef=opaque-memory-ref";
    shellFetch.mockResolvedValueOnce(new Response(JSON.stringify({ href, status: "READY" }), {
      status: 200
    }));
    render(<AnswerProcessV2 memorySources={[{
      actions: ["CORRECT", "FORGET", "NOT_RELEVANT", "OPEN_SOURCE"],
      date: "2026-08-21T05:00:00.000Z",
      memoryRef: "opaque-memory-ref",
      origin: "Previous discussion",
      sourceAvailable: true,
      sourceType: "PAST_CHAT",
      text: "The earlier discussion chose concise answers."
    }]} />);
    openProcess();

    fireEvent.click(screen.getByRole("button", { name: "Open source" }));
    await waitFor(() => expect(screen.getByRole("link", { name: "Open source" })).toHaveAttribute(
      "href",
      href
    ));
    expect(screen.getByRole("link", { name: "Open source" })).toHaveAttribute("rel", "noreferrer");
    expect(document.body.textContent).not.toContain("opaque-memory-ref");
  });

  it("does not show private source text or actions when a source is unavailable", () => {
    render(<AnswerProcessV2 memorySources={[{
      actions: [],
      date: "2026-08-21T05:00:00.000Z",
      sourceAvailable: false,
      sourceType: "SAVED_MEMORY"
    }]} />);
    openProcess();

    expect(screen.getByText("Source unavailable")).toBeVisible();
    expect(screen.getByText("This Memory source is unavailable.")).toBeVisible();
    expect(screen.queryByText("private text that must stay hidden")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Memory actions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
  });

  it("shows a bounded friendly notice when Memory was unavailable for this response", () => {
    render(<AnswerOutputsV2 artifact={{
      citations: [],
      memoryStatus: "UNAVAILABLE",
      reasoningText: [],
      sources: []
    }} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Memory was unavailable for this response."
    );
    expect(screen.getByTestId("memory-unavailable-status")).not.toHaveTextContent(
      /FAILED_SAFE|DEGRADED|error|code/i
    );
  });

  it("says Memory was limited instead of unavailable when a degraded pack was used", () => {
    render(<AnswerOutputsV2 artifact={{
      citations: [],
      memoryStatus: "LIMITED",
      reasoningText: [],
      sources: []
    }} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Memory was used with limitations for this response."
    );
    expect(screen.getByTestId("memory-limited-status")).not.toHaveTextContent(
      /FAILED_SAFE|DEGRADED|error|code/i
    );
    expect(screen.queryByText("Memory was unavailable for this response."))
      .not.toBeInTheDocument();
  });
});
