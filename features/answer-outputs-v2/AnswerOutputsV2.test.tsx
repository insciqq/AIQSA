import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ThreadArtifactSummary } from "@/lib/contracts/chats";
import { RunAnswerV2 } from "@/features/run-lifecycle-v2/RunLifecycleV2";
import { summarizeThreadArtifacts } from "@/components/app-shell/threadContent";
import { foldReasoningEntries } from "@/lib/domain/answerReasoning";
import { describe, expect, it, vi } from "vitest";
import { AnswerOutputsV2, ArtifactGenerationCardsV2 } from "./AnswerOutputsV2";
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
  reasoningText: ["**Compared sources** without exposing the query."],
  sources: [{
    rank: 1,
    snippet: "Bounded safe snippet.",
    title: "Cross-language retrieval",
    url: "https://example.com/retrieval"
  }],
  workDurationMs: 12_400
};

/** The process fold is collapsed by default; tests open it first. */
function openProcess() {
  for (const fold of document.querySelectorAll("details")) {
    (fold as HTMLDetailsElement).open = true;
  }
}

describe("answer outputs v2", () => {
  it("keeps Memory search steps inspectable while running and shows the settled outcome", () => {
    const call = { origin: "memory" as const, serverName: "Memory", toolName: "memory_search",
      memorySearchCall: 1, round: 1, status: "running" as const };
    const { rerender } = render(<AnswerProcessV2 liveLabel="Searching memory…" toolActivity={{ calls: [call] }} />);
    const disclosure = screen.getByTestId("tool-activity-disclosure");
    expect(disclosure).toHaveTextContent("Searching memory…");
    openProcess();
    expect(screen.getByText("Searching memory")).toBeVisible();
    rerender(<AnswerProcessV2 toolActivity={{ calls: [{ ...call, status: "complete", memorySearchOutcome: "no_results" }] }} />);
    expect(screen.getByText("No matching memories found")).toBeVisible();
    expect(disclosure).not.toHaveTextContent("memory_search");
  });

  it("lists the servers a tool search could not load under its step, with reason and recovery", () => {
    const call = { origin: "discovery" as const, round: 1, serverName: "Auto tools", status: "complete" as const,
      toolName: "find_tools" };
    const { rerender } = render(<AnswerProcessV2 toolActivity={{ calls: [{ ...call, mcpUnavailable: [
      { name: "Gitlab", reason: "mcp_reauthorization_required" },
      { name: "Kaiten", reason: "mcp_personal_credential_rejected" },
      { name: "Tracker", reason: "mcp_server_unavailable" },
      { name: "Wiki", reason: "mcp_server_starting" }
    ] }] }} />);
    openProcess();
    expect(screen.getByText("Found relevant tools")).toBeVisible();
    const list = screen.getByTestId("mcp-unavailable-servers");
    expect(within(list).getByText("Unavailable now")).toBeVisible();
    expect(within(list).getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      "Gitlab · Sign-in needed Reconnect it in MCP settings.",
      "Kaiten · Credential rejected Update the personal value or reconnect it in MCP settings.",
      "Tracker · Unavailable right now Try again later or check it in MCP settings.",
      "Wiki · Still starting Ask again in a minute."
    ]);
    // A search that loaded everything shows no list.
    rerender(<AnswerProcessV2 toolActivity={{ calls: [call] }} />);
    expect(screen.queryByTestId("mcp-unavailable-servers")).not.toBeInTheDocument();
  });

  it("marks a live expandable process line with a trailing chevron until it settles", () => {
    const workspace = { entries: [{ id: "run", kind: "command", phase: "running", command: { preview: "pwd" } }] } as const;
    const { rerender } = render(<AnswerProcessV2 liveLabel="Working in Workspace…" workspaceActivity={workspace} />);
    const disclosure = screen.getByTestId("tool-activity-disclosure");
    expect(disclosure.querySelector("summary")).toContainElement(screen.getByTestId("answer-process-live-chevron"));
    rerender(<AnswerProcessV2 liveLabel="Thinking…" />);
    expect(screen.getByTestId("run-status-line")).toHaveTextContent("Thinking…");
    expect(screen.queryByTestId("answer-process-live-chevron")).not.toBeInTheDocument();
    rerender(<AnswerProcessV2 workspaceActivity={workspace} />);
    expect(screen.getByTestId("tool-activity-disclosure")).toHaveTextContent("Worked in Workspace");
    expect(screen.queryByTestId("answer-process-live-chevron")).not.toBeInTheDocument();
  });

  it("shows pending and stopped creation honestly, then replaces it with the authoritative saved card", () => {
    const onOpen = vi.fn();
    const onOpenArtifact = vi.fn();
    const pending = { draftId: "draft", status: "pending" as const, title: "Notebook", files: [] };
    const { rerender } = render(<ArtifactGenerationCardsV2 drafts={[pending]} onOpen={onOpen} onOpenArtifact={onOpenArtifact} />);
    expect(screen.getByRole("status")).toHaveTextContent("Creating artifact…");
    const card = screen.getByRole("button", { name: "Open artifact code: Notebook" });
    fireEvent.click(card);
    expect(onOpen).toHaveBeenCalledWith("draft", card);
    rerender(<ArtifactGenerationCardsV2 drafts={[{ ...pending, status: "cancelled" }]} onOpen={onOpen} onOpenArtifact={onOpenArtifact} />);
    expect(screen.getByRole("status")).toHaveTextContent("Artifact wasn’t created. Creation was stopped.");
    const saved = { artifactId: "saved", versionId: "v1", versionNumber: 1, title: "Notebook", kind: "html" as const, entrypoint: "index.html" };
    rerender(<ArtifactGenerationCardsV2 drafts={[{ ...pending, status: "ready", artifact: saved }]} onOpen={onOpen} onOpenArtifact={onOpenArtifact} />);
    fireEvent.click(screen.getByRole("button", { name: "Open artifact: Notebook" }));
    expect(onOpenArtifact).toHaveBeenCalledWith(saved, expect.any(HTMLElement));
    expect(screen.queryByText("Creating artifact…")).not.toBeInTheDocument();
    rerender(<ArtifactGenerationCardsV2 drafts={[{ ...pending, status: "ready", artifact: saved }]} savedArtifacts={[saved]} onOpen={onOpen} onOpenArtifact={onOpenArtifact} />);
    expect(screen.queryByRole("button", { name: "Open artifact: Notebook" })).not.toBeInTheDocument();
  });
  it("opens an artifact card in place and reserves a new tab for its explicit menu action", () => {
    const generated = { artifactId: "artifact", versionId: "v1", versionNumber: 1, title: "A small game", kind: "game" as const, entrypoint: "index.html" };
    const onOpenArtifact = vi.fn();
    const onEditArtifact = vi.fn();
    render(<AnswerOutputsV2 artifact={{ citations: [], sources: [], reasoningText: [], generatedArtifacts: [generated] }}
      onOpenArtifact={onOpenArtifact} onEditArtifact={onEditArtifact} />);
    const card = screen.getByRole("button", { name: "Open artifact: A small game" });
    fireEvent.click(card);
    expect(onOpenArtifact).toHaveBeenCalledWith(generated, card);
    expect(screen.queryByText("Generated artifacts")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Actions for artifact: A small game" }));
    expect(screen.getByRole("menuitem", { name: "Open in new tab" })).toHaveAttribute("target", "_blank");
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit with AI" }));
    expect(onEditArtifact).toHaveBeenCalledWith(generated);
  });

  it("updates card actions without remounting the focused card or losing its open menu", async () => {
    const older = { artifactId: "artifact", versionId: "v3", versionNumber: 3, title: "Notebook", kind: "html" as const, entrypoint: "index.html" };
    const latest = { ...older, versionId: "v4", versionNumber: 4 };
    const onOpenArtifact = vi.fn();
    const onEditArtifact = vi.fn();
    const output = (value: typeof older) => <AnswerOutputsV2
      artifact={{ citations: [], sources: [], reasoningText: [], generatedArtifacts: [value] }}
      onOpenArtifact={onOpenArtifact} onEditArtifact={onEditArtifact} />;
    const { rerender } = render(output(older));
    const card = screen.getByRole("button", { name: "Open artifact: Notebook" });
    fireEvent.click(card);
    expect(onOpenArtifact).toHaveBeenLastCalledWith(older, card);
    const actions = screen.getByRole("button", { name: "Actions for artifact: Notebook" });
    fireEvent.click(actions);
    const download = screen.getByRole("menuitem", { name: "Download ZIP" });
    download.focus();
    rerender(output(latest));
    expect(screen.getByRole("button", { name: "Open artifact: Notebook" })).toBe(card);
    expect(screen.getByRole("menuitem", { name: "Download ZIP" })).toBe(download);
    expect(download).toHaveFocus();
    expect(download).toHaveAttribute("href", "/api/artifacts/artifact/versions/v4/content?download=zip");
    expect(screen.getByRole("menuitem", { name: "Open in new tab" })).toHaveAttribute("href", "/artifacts/artifact/versions/v4");
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit with AI" }));
    expect(onEditArtifact).toHaveBeenLastCalledWith(latest);
    fireEvent.click(card);
    expect(onOpenArtifact).toHaveBeenLastCalledWith(latest, card);
    await waitFor(() => expect(actions).not.toBeDisabled());

    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ artifact: {
      id: "artifact", title: "Notebook", currentVersionId: "v4", sourceChatId: "chat", publications: [],
      versions: [older, latest].map(version => ({ ...version, id: version.versionId, createdAt: "2026-09-20T12:00:00.000Z" }))
    } }));
    try {
      fireEvent.click(actions);
      fireEvent.click(screen.getByRole("menuitem", { name: "Share…" }));
      const share = await screen.findByRole("dialog", { name: "Share “Notebook”" });
      await waitFor(() => expect(within(share).getByRole("button", { name: "Publish v4" })).toBeEnabled());
      fireEvent.click(within(share).getByRole("button", { name: "Close" }));
    } finally { fetcher.mockRestore(); }
  });

  it("coalesces ready drafts and never resurrects an older draft beside the saved card", () => {
    const earlier = { artifactId: "A", versionId: "v3", versionNumber: 3, title: "Notebook", kind: "html" as const, entrypoint: "index.html" };
    const latest = { ...earlier, versionId: "v4", versionNumber: 4 };
    const separate = { ...earlier, artifactId: "B", versionId: "b1", versionNumber: 1 };
    const drafts = [earlier, separate, latest, earlier].map((artifact, index) => ({
      draftId: `ready-${index}`, status: "ready" as const, files: [], artifact
    }));
    const onOpenArtifact = vi.fn();
    const props = { onOpen: vi.fn(), onOpenArtifact };
    const { rerender } = render(<ArtifactGenerationCardsV2 {...props} drafts={drafts} />);
    const cards = screen.getAllByRole("button", { name: "Open artifact: Notebook" });
    expect(cards).toHaveLength(2);
    fireEvent.click(cards[0]!);
    expect(onOpenArtifact).toHaveBeenLastCalledWith(latest, cards[0]);
    fireEvent.click(cards[1]!);
    expect(onOpenArtifact).toHaveBeenLastCalledWith(separate, cards[1]);
    rerender(<ArtifactGenerationCardsV2 {...props} drafts={drafts} savedArtifacts={[latest, separate]} />);
    expect(screen.queryByRole("button", { name: "Open artifact: Notebook" })).not.toBeInTheDocument();
  });

  it("hides failed attempts once the same answer created an artifact and keeps a lone failure visible", () => {
    const props = { onOpen: vi.fn(), onOpenArtifact: vi.fn() };
    const created = { artifactId: "A", versionId: "v1", versionNumber: 1, title: "Notebook", kind: "html" as const, entrypoint: "index.html" };
    const failed = { draftId: "first", title: "Notebook", files: [], status: "failed" as const };
    const retry = { draftId: "retry", title: "Notebook", files: [], status: "pending" as const };
    const { rerender } = render(<ArtifactGenerationCardsV2 {...props} drafts={[failed]} />);
    expect(screen.getByRole("status")).toHaveTextContent("Artifact wasn’t created. See the run details for the reason.");
    // While the retry runs, the earlier failure stays beside it.
    rerender(<ArtifactGenerationCardsV2 {...props} drafts={[failed, retry]} />);
    expect(screen.getAllByRole("status").map(status => status.textContent)).toEqual([
      "Artifact wasn’t created. See the run details for the reason.", "Creating artifact…"]);
    rerender(<ArtifactGenerationCardsV2 {...props} drafts={[failed, { ...retry, status: "ready", artifact: created }]} />);
    expect(screen.getByRole("button", { name: "Open artifact: Notebook" })).toBeVisible();
    expect(screen.queryByText(/wasn’t created/u)).not.toBeInTheDocument();
    // After reload of the settled answer the saved card alone stands for the retries; a stopped attempt still shows.
    const stopped = { draftId: "stopped", title: "Chart", files: [], status: "cancelled" as const };
    rerender(<ArtifactGenerationCardsV2 {...props} drafts={[failed, stopped]} savedArtifacts={[created]} />);
    expect(screen.getAllByRole("status").map(status => status.textContent)).toEqual(["Artifact wasn’t created. Creation was stopped."]);
  });

  it("shows safe Sources from the actions row and Thinking above", () => {
    render(
      <RunAnswerV2
        actions={{ onCopy: () => undefined, onRegenerate: () => undefined }}
        artifact={artifact}
        content="Answer"
        leadingSlot={<span>Quarterly analyst</span>}
        presentation={{ kind: "complete", runId: "run-1" }}
      />
    );

    expect(screen.getByText("Quarterly analyst")).toBeVisible();
    // The process line is a human phrase, never a count of tool calls.
    expect(screen.getByTestId("tool-activity-disclosure")).toHaveTextContent("Thought for 12s");
    expect(screen.queryByTestId("answer-sources")).not.toBeInTheDocument();
    const toolbar = screen.getByRole("toolbar", { name: "Answer actions" });
    const toggle = screen.getByTestId("answer-sources-toggle");
    expect(toolbar).toContainElement(toggle);
    expect(toggle).toHaveAccessibleName("Sources, 1 item");
    expect(toggle).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(toggle);
    expect(screen.getByRole("dialog", { name: "Sources" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Cross-language retrieval" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
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

  it("leaves nothing for the process line while Reasoning is hidden by preference", () => {
    render(
      <RunAnswerV2
        artifact={artifact}
        content="Answer"
        presentation={{ kind: "complete", runId: "run-1" }}
        showReasoning={false}
      />
    );
    expect(screen.queryByTestId("tool-activity-disclosure")).not.toBeInTheDocument();
  });

  it("renders no placeholder when there is no output", () => {
    const { container } = render(<AnswerOutputsV2 artifact={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows merged thinking deltas as one text, live and after reload", () => {
    const fragment = (entry: "continue" | "start", text: string) => ({
      data: { artifactType: "reasoning", payload: { entry, text } }, type: "artifact"
    });
    const live = summarizeThreadArtifacts([
      fragment("start", "Let me compare "),
      fragment("continue", "the two sources "),
      fragment("continue", "before answering.")
    ]);
    // Historical per-delta rows lost their boundary spaces; the read rule rejoins them.
    const legacy: ThreadArtifactSummary = { citations: [], sources: [], reasoningText: foldReasoningEntries(
      ["Let me compare", "the two sources", "before answering."].map((text) => ({ kind: "legacy" as const, text }))
    ).entries };
    for (const summary of [live, legacy]) {
      const { unmount } = render(
        <RunAnswerV2 artifact={summary} content="Answer" presentation={{ kind: "complete", runId: "run-1" }} />
      );
      openProcess();
      const paragraphs = within(screen.getByTestId("answer-reasoning")).getAllByText(/Let me compare/u);
      expect(paragraphs).toHaveLength(1);
      expect(paragraphs[0]).toHaveTextContent("Let me compare the two sources before answering.");
      expect(screen.queryByTestId("answer-reasoning-truncated")).not.toBeInTheDocument();
      unmount();
    }
  });

  it("says when thinking or the source list is only partly shown", () => {
    render(
      <RunAnswerV2
        artifact={{ ...artifact, citationsTruncated: true, reasoningTruncated: true }}
        content="Answer"
        presentation={{ kind: "complete", runId: "run-1" }}
      />
    );
    openProcess();
    expect(screen.getByTestId("answer-reasoning-truncated")).toHaveTextContent("Thinking is too long to show in full.");
    fireEvent.click(screen.getByTestId("answer-sources-toggle"));
    expect(screen.getByTestId("answer-sources-truncated"))
      .toHaveTextContent("This answer has more sources than can be listed.");
  });

  it("keeps a page read the run skipped by its rules neutral, and a page that could not be read a failure", () => {
    render(<AnswerProcessV2 toolActivity={{ calls: [
      { durationMs: 94, fetchOutcome: "fetch_url_not_in_conversation", fetchTarget: "www.shop.example/tariffs",
        origin: "web_fetch", round: 3, status: "error", toolName: "fetch_url" },
      { durationMs: 1200, fetchOutcome: "fetch_network_error", fetchTarget: "down.example/page",
        origin: "web_fetch", round: 3, status: "error", toolName: "fetch_url" }
    ] }} />);
    openProcess();

    const [skipped, failed] = screen.getAllByRole("listitem");
    expect(skipped).toHaveTextContent("Skipped www.shop.example/tariffs: only links from the chat or web search were read then");
    expect(skipped).toHaveTextContent("94 ms");
    expect(skipped).not.toHaveTextContent("round");
    expect(skipped!.querySelector(".v2-answer-process-mark")).toHaveAttribute("data-status", "cancelled");
    // The label already names the failure; the meta is only its time.
    expect(failed).toHaveTextContent(/^Couldn't read down\.example\/page: the site is unreachable1\.2 s$/u);
    expect(failed!.querySelector(".v2-answer-process-mark")).toHaveAttribute("data-status", "error");
  });

  it("renders a proxy's display name as text and gives a stable proxy failure reason", () => {
    const name = '<img src=x onerror="alert(1)">';
    const { container } = render(<AnswerProcessV2 toolActivity={{ calls: [
      { fetchOutcome: "read", fetchProxyName: name, fetchTarget: "news.example/page",
        origin: "web_fetch", round: 1, status: "complete", toolName: "fetch_url" },
      { fetchOutcome: "fetch_network_error", fetchProxyName: "Personal route", fetchProxyCode: "proxy_auth_failed", fetchTarget: "news.example/page",
        origin: "web_fetch", round: 1, status: "error", toolName: "fetch_url" },
      { fetchOutcome: "read", fetchTarget: "news.example/legacy", origin: "web_fetch", round: 1, status: "complete", toolName: "fetch_url" }
    ] }} />);
    openProcess();
    const [read, failed, legacy] = screen.getAllByRole("listitem");
    expect(read).toHaveTextContent(`Read news.example/page via proxy “${name}”`);
    expect(failed).toHaveTextContent("Couldn't read news.example/page via proxy “Personal route”: proxy sign-in failed");
    expect(legacy).toHaveTextContent("Read news.example/legacy");
    expect(legacy).not.toHaveTextContent("proxy");
    expect(container.querySelector("img")).toBeNull();
  });

  it("keeps search counts off the line and shows them, failures included, as one row in the fold", () => {
    render(<AnswerProcessV2 toolActivity={{ calls: [
      { origin: "web_search", round: 2, status: "complete", toolName: "search" }
    ], searchEngines: [
      { engine: 1, name: "Perplexity", requested: 3, settled: 2, complete: 2, error: 0, skipped: 0 },
      { engine: 2, name: "OpenAI (CodexLB)", requested: 3, settled: 3, complete: 1, error: 1, skipped: 1 }
    ] }} workDurationMs={106_000} />);
    const line = screen.getByTestId("tool-activity-disclosure").querySelector("summary");
    expect(line).toHaveTextContent(/^Worked for 1m 46s$/u);
    openProcess();
    // The fold says the counts once, and lists the searches as steps.
    expect(screen.getByTestId("answer-search-engines"))
      .toHaveTextContent("Perplexity ×2 · 1 in progress · OpenAI (CodexLB) ×1 · 1 unsuccessful · 1 skipped");
    expect(screen.getAllByText(/Perplexity ×2/u)).toHaveLength(1);
    expect(screen.getByText("Searched the web")).toBeVisible();
    // Rounds are the engine's bookkeeping, not something the user acts on.
    expect(screen.queryByText(/round/iu)).toBeNull();
  });

  it("gives a search with no steps its own line and a fold", () => {
    render(<AnswerProcessV2 toolActivity={{ calls: [], searchEngines: [
      { engine: 1, name: "Perplexity", requested: 2, settled: 2, complete: 1, error: 1, skipped: 0 }
    ] }} />);
    const line = screen.getByTestId("tool-activity-disclosure").querySelector("summary");
    expect(line).toHaveTextContent(/^Searched the web$/u);
    openProcess();
    expect(screen.getByTestId("answer-search-engines")).toHaveTextContent("Perplexity ×1 · 1 unsuccessful");
  });

  it("keeps a search that entirely failed visible on the line", () => {
    const engines = [
      { engine: 1, name: "Perplexity", requested: 2, settled: 2, complete: 0, error: 2, skipped: 0 },
      { engine: 2, name: "Exa", requested: 1, settled: 1, complete: 0, error: 1, skipped: 0 }
    ];
    const { rerender } = render(<AnswerProcessV2 toolActivity={{ calls: [], searchEngines: engines }} />);
    const line = () => screen.getByTestId("tool-activity-disclosure").querySelector("summary");
    expect(line()).toHaveTextContent(/^Web search failed$/u);
    rerender(<AnswerProcessV2 toolActivity={{ calls: [
      { durationMs: 900, origin: "web_search", round: 1, status: "error", toolName: "search" }
    ], searchEngines: engines }} workDurationMs={8_000} />);
    expect(line()).toHaveTextContent(/^Worked for 8s · Web search failed$/u);
  });

  it("never claims a search succeeded or failed when no outcome says so", () => {
    render(<AnswerProcessV2 toolActivity={{ calls: [], searchEngines: [
      { engine: 1, name: "Perplexity", requested: 2, settled: 1, complete: 0, error: 1, skipped: 0 }
    ] }} />);
    expect(screen.getByTestId("tool-activity-disclosure").querySelector("summary")).toHaveTextContent(/^Web search$/u);
  });

  it("drops search counts from the live line and keeps them in the fold", () => {
    render(<AnswerProcessV2 liveLabel="Searching the web…" toolActivity={{ calls: [
      { origin: "web_search", round: 1, status: "running", toolName: "search" }
    ], searchEngines: [
      { engine: 1, name: "Perplexity", requested: 2, settled: 1, complete: 1, error: 0, skipped: 0 }
    ] }} />);
    expect(screen.getByTestId("tool-activity-disclosure").querySelector("summary")).toHaveTextContent(/^Searching the web…$/u);
  });

  it("gives an answer whose only fact is a read PDF a line and a Documents section", () => {
    const document = { answerModelName: "Sonnet", completedPages: 0, limitedReadingQuality: false, longDocument: false,
      pageCount: 2, phase: "ready", retryable: false, route: "direct_pdf" } as const;
    const { rerender } = render(<AnswerProcessV2 documents={[document]} />);
    const line = () => screen.getByTestId("tool-activity-disclosure").querySelector("summary");
    expect(line()).toHaveTextContent(/^Read 1 PDF$/u);
    openProcess();
    expect(screen.getByTestId("answer-documents")).toHaveTextContent("Read the original PDF · Sonnet");
    rerender(<AnswerProcessV2 documents={[document, { ...document, limitedReadingQuality: true, route: "local_text" }]} />);
    expect(line()).toHaveTextContent(/^Read 2 PDFs$/u);
    expect(screen.getByTestId("answer-documents")).toHaveTextContent("Read with basic text extraction · Sonnet");
    expect(screen.getByTestId("tool-activity-disclosure")).not.toHaveTextContent(/reading quality/iu);
    // The work time leads when there is one; the route stays in the fold.
    rerender(<AnswerProcessV2 documents={[document]} reasoningTexts={["Looked at the pages."]} workDurationMs={12_000} />);
    expect(line()).toHaveTextContent(/^Thought for 12s$/u);
  });

  it("describes no document whose preparation did not finish", () => {
    render(<AnswerProcessV2 documents={[{ completedPages: 0, limitedReadingQuality: false, longDocument: false,
      pageCount: 2, phase: "cancelled", retryable: false, route: "system_pdf" }]} />);
    expect(screen.queryByTestId("tool-activity-disclosure")).toBeNull();
    expect(screen.queryByText(/PDF/u)).toBeNull();
  });

  it("folds consecutive finished calls of one tool into one row and keeps a running call apart", () => {
    const listCommits = { origin: "mcp", round: 2, serverName: "GitLab", status: "complete", toolName: "list_commits" } as const;
    render(<AnswerProcessV2 toolActivity={{ calls: [
      { origin: "discovery", round: 1, status: "complete", toolName: "find_tools" },
      { ...listCommits, durationMs: 720 },
      { ...listCommits, durationMs: 369, round: 4 },
      { ...listCommits, durationMs: 360, round: 4 },
      { ...listCommits, round: 5, status: "running" }
    ] }} />);
    (screen.getByTestId("tool-activity-disclosure") as HTMLDetailsElement).open = true;

    const group = screen.getByTestId("tool-call-group");
    expect(group).toHaveTextContent("Used GitLab: list commits ×3");
    expect(group).toHaveTextContent("1.4 s");
    expect(group).not.toHaveAttribute("open");
    fireEvent.click(within(group).getByText("Used GitLab: list commits ×3"));
    expect(within(group).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Call 1720 ms", "Call 2369 ms", "Call 3360 ms"]);
    expect(screen.getByText("Using GitLab: list commits")).toBeVisible();
  });

  it.each([
    ["running", "Using Repository Tools: search"],
    ["complete", "Used Repository Tools: search"],
    ["error", "Repository Tools: search failed"],
    ["cancelled", "Repository Tools: search stopped"]
  ] as const)("renders a %s MCP search with its source and actual status", (status, label) => {
    render(<AnswerProcessV2 toolActivity={{ calls: [{
      origin: "mcp", round: 2, serverName: "Repository Tools", status, toolName: "search"
    }] }} />);
    openProcess();

    expect(screen.getByText(label)).toBeVisible();
    expect(screen.getByRole("listitem")).toHaveAttribute("data-status", status);
    expect(screen.queryByText(/^(Failed|Stopped)$/u)).toBeNull();
    expect(document.body.textContent).not.toMatch(/Searched the web|Searching the web/iu);
  });

  it("names a call waiting for approval as not sent, never as failed", () => {
    render(<AnswerProcessV2 toolActivity={{ calls: [{
      approvalRequired: true, origin: "mcp", round: 1, serverName: "Records", status: "error", toolName: "delete_record"
    }] }} />);
    openProcess();

    expect(screen.getByRole("listitem")).toHaveTextContent(/^Records: delete recordNot sent · needs approval$/u);
    expect(document.body.textContent).not.toMatch(/failed/iu);
  });

  it("leaves a server named Workspace in MCP steps and keeps actual Workspace owned by its timeline", () => {
    render(<AnswerProcessV2 toolActivity={{ calls: [
      { origin: "mcp", round: 1, serverName: "Workspace", status: "complete", toolName: "find_tools" },
      { origin: "workspace", round: 2, serverName: "Execution tools", status: "complete", toolName: "sandbox_fs_read" },
      { origin: "web_search", round: 3, serverName: "Catalog Search", status: "error", toolName: "search" }
    ] }} />);
    openProcess();

    expect(screen.getByText("Used Workspace: find tools")).toBeVisible();
    expect(screen.getByText("Web search failed")).toBeVisible();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(document.body.textContent).not.toMatch(/sandbox_fs_read|Execution tools|Searched the web/iu);
  });

  it("drops a failed Memory search step without a failure word or alert icon", () => {
    const failed = { origin: "memory" as const, serverName: "Memory", toolName: "memory_search",
      memorySearchCall: 1, round: 1, status: "error" as const, memorySearchOutcome: "failure" as const };
    const { container, rerender } = render(<AnswerProcessV2 toolActivity={{ calls: [failed] }} workDurationMs={12_400} />);
    expect(container.textContent).not.toMatch(/memory|fail|unavailable/iu);
    rerender(<AnswerProcessV2 toolActivity={{ calls: [failed, { ...failed, memorySearchCall: 2, status: "complete",
      memorySearchOutcome: "limited" as const }] }} />);
    openProcess();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("Searched memory")).toBeVisible();
    expect(container.textContent).not.toMatch(/fail|unavailable|limited/iu);
    expect(container.querySelector("[data-status='error']")).toBeNull();
  });

  it("shows an image file output inline and in the viewer through the authorized preview, keeping its card", async () => {
    render(<AnswerOutputsV2 canSaveFiles artifact={{
      citations: [],
      generatedFiles: [
        { attachmentId: "chart-id", byteSize: 226_918, fileName: "profit_by_month_2026.png", mimeType: "image/png",
          relativePath: "charts/profit_by_month_2026.png" },
        { attachmentId: "table-id", byteSize: 2_048, fileName: "profit.csv", mimeType: "text/csv", relativePath: "profit.csv" }
      ],
      reasoningText: [],
      sources: []
    }} />);

    const region = screen.getByRole("region", { name: "Generated files" });
    const inline = within(region).getAllByRole("img");
    expect(inline.map((image) => image.getAttribute("src"))).toEqual(["/api/attachments/chart-id/content?preview=image"]);
    // The card keeps its verbs; the inline image adds no second Download.
    expect(within(region).getAllByRole("link", { name: "Download" }).map((link) => link.getAttribute("href")))
      .toEqual(["/api/attachments/chart-id/content", "/api/attachments/table-id/content"]);
    // A CSV is text, so its name opens the text preview (tested below), never the image viewer.
    expect(within(region).getByRole("button", { name: "profit.csv" })).toHaveAttribute("aria-haspopup", "dialog");

    const name = within(region).getByRole("button", { name: "profit_by_month_2026.png" });
    name.focus();
    fireEvent.click(name);
    const viewer = screen.getByRole("dialog", { name: "profit_by_month_2026.png" });
    expect(viewer.querySelector("img")?.getAttribute("src")).toBe("/api/attachments/chart-id/content?preview=image");
    fireEvent.keyDown(viewer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(name).toHaveFocus();
  });

  it("opens a text file output in the text preview and a Markdown one rendered, with its source", async () => {
    shellFetch.mockReset();
    shellFetch.mockImplementation(async (url: string) => new Response(
      url.includes("notes-id") ? "# Notes\n\nFirst **point**." : "# Netscape HTTP Cookie File\nexample.com\tTRUE",
      { headers: { "content-type": "text/plain; charset=utf-8" }, status: 200 }
    ));
    render(<AnswerOutputsV2 canSaveFiles artifact={{
      citations: [],
      generatedFiles: [
        { attachmentId: "cookies-id", byteSize: 3_650, fileName: "youtube_cookies.txt", mimeType: "text/plain",
          relativePath: "youtube_cookies.txt" },
        { attachmentId: "notes-id", byteSize: 120, fileName: "notes.md", mimeType: "text/markdown", relativePath: "notes.md" },
        { attachmentId: "archive-id", byteSize: 2_048, fileName: "site.zip", mimeType: "application/zip", relativePath: "site.zip" }
      ],
      reasoningText: [],
      sources: []
    }} />);

    const region = screen.getByRole("region", { name: "Generated files" });
    expect(within(region).queryAllByRole("img")).toEqual([]);
    expect(within(region).queryByRole("button", { name: "site.zip" })).toBeNull();

    const text = within(region).getByRole("button", { name: "youtube_cookies.txt" });
    text.focus();
    fireEvent.click(text);
    const viewer = await screen.findByRole("dialog", { name: "File preview: youtube_cookies.txt" });
    await waitFor(() => expect(viewer).toHaveTextContent("# Netscape HTTP Cookie File"));
    expect(shellFetch.mock.calls[0]?.[0]).toBe("/api/attachments/cookies-id/content?preview=text");
    expect(within(viewer).queryByRole("radiogroup", { name: "Preview mode" })).toBeNull();
    expect(within(viewer).getByRole("button", { name: "Copy" })).toBeVisible();
    fireEvent.click(within(viewer).getByRole("button", { name: "Close preview" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // The type tile opens it too, for the pointer only: the name stays the one control, and focus comes back to it.
    const tiles = region.querySelectorAll<HTMLButtonElement>("button.v2-generated-file-tile");
    expect(tiles).toHaveLength(2);
    expect(tiles[0]).toHaveAttribute("tabindex", "-1");
    expect(tiles[0]).toHaveAttribute("aria-hidden", "true");
    expect(region.querySelector("li:last-child .v2-generated-file-tile")?.tagName).toBe("SPAN");
    fireEvent.click(tiles[0]!);
    const again = await screen.findByRole("dialog", { name: "File preview: youtube_cookies.txt" });
    fireEvent.click(within(again).getByRole("button", { name: "Close preview" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(text).toHaveFocus());

    fireEvent.click(within(region).getByRole("button", { name: "notes.md" }));
    const markdown = await screen.findByRole("dialog", { name: "File preview: notes.md" });
    await waitFor(() => expect(within(markdown).getByRole("heading", { name: "Notes" })).toBeVisible());
    expect(shellFetch.mock.calls.at(-1)?.[0]).toBe("/api/attachments/notes-id/content?preview=text");
    // One click copies the whole file in the rendered view too.
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    fireEvent.click(within(markdown).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(within(markdown).getByRole("button", { name: "Copied" })).toBeVisible());
    expect(writeText).toHaveBeenCalledWith("# Notes\n\nFirst **point**.");
    fireEvent.click(within(markdown).getByRole("radio", { name: "Source" }));
    await waitFor(() => expect(markdown).toHaveTextContent("First **point**."));
  });

  it("hands a PDF or text output to the chat's panel when it has one, and keeps an image's own viewer", () => {
    const onOpenFile = vi.fn();
    const files = [
      { attachmentId: "notes-id", byteSize: 120, fileName: "notes.md", mimeType: "text/markdown", relativePath: "notes.md" },
      { attachmentId: "report-id", byteSize: 2_048, fileName: "report.pdf", mimeType: "application/pdf", relativePath: "report.pdf" },
      { attachmentId: "chart-id", byteSize: 2_048, fileName: "chart.png", mimeType: "image/png", relativePath: "chart.png" }
    ];
    render(<AnswerOutputsV2 canSaveFiles onOpenFile={onOpenFile} artifact={{ citations: [], generatedFiles: files, reasoningText: [], sources: [] }} />);
    const region = screen.getByRole("region", { name: "Generated files" });
    const notes = within(region).getByRole("button", { name: "notes.md" });
    // A panel is no dialog.
    expect(notes).not.toHaveAttribute("aria-haspopup");
    fireEvent.click(notes);
    expect(onOpenFile).toHaveBeenLastCalledWith(files[0], "text", notes);
    const report = within(region).getByRole("button", { name: "report.pdf" });
    fireEvent.click(region.querySelectorAll<HTMLButtonElement>("button.v2-generated-file-tile")[1]!);
    expect(onOpenFile).toHaveBeenLastCalledWith(files[1], "pdf", report);
    expect(report).toHaveFocus();
    expect(screen.queryByRole("dialog")).toBeNull();
    const chart = within(region).getByRole("button", { name: "chart.png" });
    expect(chart).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(chart);
    expect(onOpenFile).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("dialog", { name: "chart.png" })).toBeVisible();
  });

  it("renders settled generated files with safe metadata and authorized downloads", () => {
    render(<AnswerOutputsV2 artifact={{
      citations: [],
      generatedFiles: [{
        attachmentId: "generated-file-id",
        byteSize: 18_400_000,
        fileName: "fixed-project.tar.gz",
        mimeType: "application/gzip",
        relativePath: "fixed-project.tar.gz"
      }],
      reasoningText: [],
      sources: []
    }} />);

    const region = screen.getByRole("region", { name: "Generated files" });
    expect(region).toHaveTextContent("fixed-project.tar.gz");
    expect(region).toHaveTextContent("TAR.GZ");
    expect(region).toHaveTextContent("17.5 MB");
    expect(screen.getByRole("link", { name: /Download/u })).toHaveAttribute(
      "href",
      "/api/attachments/generated-file-id/content"
    );
  });
});

describe("AnswerOutputsV2 Workspace output status", () => {
  it("keeps settled generated files visible under the export warning", () => {
    render(
      <AnswerOutputsV2
        artifact={{
          citations: [],
          generatedFiles: [{ attachmentId: "att-1", byteSize: 4_200, fileName: "report.md", mimeType: "text/markdown", relativePath: "report.md" }],
          reasoningText: [],
          sources: []
        }}
        workspaceOutputStatus={{ errorCode: "workspace_output_export_failed", state: "retrying" }}
      />
    );
    expect(screen.getByTestId("workspace-output-status")).toHaveTextContent("still being prepared");
    expect(screen.getByRole("link", { name: /Download/u })).toHaveAttribute("href", "/api/attachments/att-1/content");
    expect(screen.getByRole("region", { name: "Generated files" })).toBeVisible();
  });

  it("explains a permanent export failure even without generated files", () => {
    render(<AnswerOutputsV2 artifact={null} workspaceOutputStatus={{ state: "failed" }} />);
    expect(screen.getByTestId("workspace-output-status")).toHaveTextContent("could not be prepared for download");
  });

  it.each(["workspace_output_limit_exceeded", "workspace_output_export_failed", "workspace_execution_cleanup_failed"] as const)(
    "keeps the reloaded answer visible with file recovery instructions for %s", (errorCode) => {
      render(<RunAnswerV2 content="The finished answer." artifact={null} presentation={{ kind: "complete", runId: "run-1" }}
        actionsSlot={<AnswerOutputsV2 artifact={null} workspaceOutputStatus={{ state: "failed", errorCode }} />} />);
      expect(screen.getByText("The finished answer.")).toBeVisible();
      expect(screen.getByTestId("workspace-output-status")).toHaveTextContent(/The answer is kept.*Ask the agent.*export them again/u);
      expect(screen.getByTestId("workspace-output-status")).toHaveTextContent(errorCode === "workspace_output_limit_exceeded"
        ? "reduce the output files" : "check the existing files");
    }
  );
});


it("offers immutable draft downloads before answer text and keeps them after failure alongside final exports", () => {
  const checkpoint = { id: "cp-1", description: "Layout before risky export", createdAt: "2026-09-24T09:00:00.000Z" };
  const file = { attachmentId: "draft-1", byteSize: 90, fileName: "layout.psd", mimeType: "application/octet-stream", relativePath: "layout.psd", checkpoint };
  const second = { ...file, attachmentId: "draft-2", checkpoint: { ...checkpoint, id: "cp-2", description: "Revised layout" } };
  const final = { attachmentId: "final", byteSize: 100, fileName: "layout.psd", mimeType: file.mimeType, relativePath: file.relativePath };
  const summary = { citations: [], reasoningText: [], sources: [], generatedFiles: [file, second, final] };
  const { rerender } = render(<RunAnswerV2 content="" artifact={null} presentation={{ kind: "streaming", runId: "run" }}
    actionsSlot={<AnswerOutputsV2 live artifact={summary} />} />);
  const downloads = () => screen.getAllByRole("link", { name: "Download" }).map(link => link.getAttribute("href"));
  expect(downloads()).toEqual(["/api/attachments/draft-1/content", "/api/attachments/draft-2/content"]);
  // A draft has the final card's two lines: its description and time are the meta line's tooltip.
  const metas = screen.getAllByText(/^Draft · PSD · /u);
  expect(metas).toHaveLength(2);
  expect(metas[0]).toHaveAttribute("title", expect.stringMatching(/^Layout before risky export\n.+/u));
  expect(metas[1]).toHaveAttribute("title", expect.stringMatching(/^Revised layout\n.+/u));
  expect(screen.queryByText("Layout before risky export")).not.toBeInTheDocument();
  expect(screen.queryByText(/Final export ·/)).not.toBeInTheDocument();
  for (const card of within(screen.getByRole("region", { name: "Generated files" })).getAllByRole("listitem")) {
    expect(card.querySelectorAll("small")).toHaveLength(1);
  }
  rerender(<AnswerOutputsV2 artifact={summary} workspaceOutputStatus={{ state: "failed", errorCode: "workspace_session_lost" }} />);
  expect(downloads()).toEqual(["/api/attachments/draft-1/content", "/api/attachments/draft-2/content", "/api/attachments/final/content"]);
  expect(screen.getAllByText("layout.psd")).toHaveLength(3);
  expect(screen.getAllByText(/^Draft · /u)).toHaveLength(2);
  expect(screen.getByText(/^PSD · /u)).not.toHaveAttribute("title");
  expect(screen.getByTestId("workspace-output-status")).toHaveTextContent("could not be prepared");
});

it("shows a file attached from the user's computer while the answer streams and once it settles, with its download", () => {
  const computer = { attachmentId: "computer-1", byteSize: 2_048, fileName: "report.pdf", mimeType: "application/pdf",
    relativePath: "report.pdf", source: "computer" as const };
  const live = summarizeThreadArtifacts([{ type: "artifact", data: { artifactType: "computer_file", payload: computer } }]);
  expect(live?.generatedFiles).toEqual([computer]);
  const { rerender } = render(<AnswerOutputsV2 live artifact={live} />);
  const download = () => within(screen.getByRole("region", { name: "Generated files" })).getByRole("link", { name: "Download" });
  expect(download()).toHaveAttribute("href", "/api/attachments/computer-1/content");
  expect(screen.getByText("report.pdf")).toBeVisible();
  expect(screen.queryByText(/^Draft · /u)).not.toBeInTheDocument();
  // Settled with a Workspace export in progress: the computer file is no Workspace file being exported.
  rerender(<AnswerOutputsV2 artifact={live} workspaceOutputStatus={{ state: "exporting" }} />);
  expect(download()).toHaveAttribute("href", "/api/attachments/computer-1/content");
  expect(screen.getByTestId("workspace-output-status")).toHaveTextContent("Preparing generated files");
});

it("keeps a draft's card and image preview as the same elements when the answer settles", () => {
  const checkpoint = { id: "cp-png", description: "Cart page before checkout", createdAt: "2026-10-27T10:49:43.000Z" };
  const final = { attachmentId: "draft-png", byteSize: 56_115, fileName: "cart.png", mimeType: "image/png", relativePath: "cart.png" };
  const summary = { citations: [], reasoningText: [], sources: [] };
  const { rerender } = render(<AnswerOutputsV2 live artifact={{ ...summary, generatedFiles: [{ ...final, checkpoint }] }} />);
  const files = () => screen.getByRole("region", { name: "Generated files" });
  const card = within(files()).getByRole("listitem");
  const image = within(files()).getByRole("img", { name: "cart.png" });
  expect(card).toHaveTextContent(/^cart\.pngDraft · PNG · \S+ KB$/u);
  rerender(<AnswerOutputsV2 artifact={{ ...summary, generatedFiles: [final] }} />);
  // Only the marker goes: nothing is mounted again, so nothing reloads or moves.
  expect(within(files()).getByRole("listitem")).toBe(card);
  expect(within(files()).getByRole("img", { name: "cart.png" })).toBe(image);
  expect(card).toHaveTextContent(/^cart\.pngPNG · \S+ KB$/u);
});

it("keeps historical failed commands in the disclosure without a false aggregate warning", () => {
  render(<AnswerProcessV2 workspaceActivity={{ outputStatus: { state: "complete" }, entries: [
    { id: "failed-before-recovery", kind: "command", phase: "failed", command: { preview: "first-attempt", exitCode: 17 } },
    { id: "execution", kind: "execution_status", phase: "closed" }
  ] }} />);
  expect(screen.getByText("Worked in Workspace")).toBeVisible();
  expect(screen.queryByText(/Needs attention/u)).not.toBeInTheDocument();
  expect(screen.getByText("first-attempt failed")).toBeInTheDocument();
});

it("keeps Past chats under the ordinary process label after an empty Workspace handoff", () => {
  const pastChat = { chatId: "chat-1", chatTitle: "Earlier chat", date: "2026-09-06T10:00:00.000Z",
    excerpt: "Previous context", messageId: "message-1" };
  const empty = { entries: [{ id: "closed", kind: "execution_status", phase: "closed" }],
    outputStatus: { state: "complete" } } as const;
  const { rerender } = render(<AnswerProcessV2 liveLabel="Thinking…" workspaceActivity={empty} />);
  expect(screen.getByTestId("run-status-line")).toHaveTextContent("Thinking…");
  expect(screen.queryByText(/Worked in Workspace/u)).not.toBeInTheDocument();
  rerender(<AnswerProcessV2 pastChatSources={[pastChat]} workspaceActivity={empty} />);
  const process = screen.getByTestId("tool-activity-disclosure");
  expect(process.querySelector("summary")).toHaveTextContent(/^Past chats · 1$/u);
  expect(process).not.toHaveAttribute("data-workspace");
  expect(screen.queryByTestId("workspace-activity-section")).not.toBeInTheDocument();
});

it("shows output-only files even when the export activity event was lost", () => {
  const output = { attachmentId: "output", byteSize: 12, fileName: "report.txt",
    mimeType: "text/plain", relativePath: "report.txt" };
  render(<RunAnswerV2 content="Done." artifact={{ citations: [], sources: [], reasoningText: [], generatedFiles: [output] }}
    presentation={{ kind: "complete", runId: "output-run" }}
    workspaceActivity={{ entries: [{ id: "closed", kind: "execution_status", phase: "closed" }],
      outputStatus: { state: "complete" } }}
    actionsSlot={<AnswerOutputsV2 artifact={{ citations: [], sources: [], reasoningText: [], generatedFiles: [output] }} />} />);
  const process = screen.getByTestId("tool-activity-disclosure");
  expect(process).toHaveAttribute("data-workspace", "true");
  expect(process.querySelector("summary")).toHaveTextContent("Worked in Workspace");
  openProcess();
  expect(screen.getByText("1 file available for download")).toBeVisible();
  expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute("href", "/api/attachments/output/content");
  expect(screen.queryByText("Workspace execution ended")).not.toBeInTheDocument();
});

it("keeps failed export and unknown cleanup visible without the successful closure row", () => {
  const { rerender } = render(<AnswerProcessV2 workspaceActivity={{
    entries: [{ id: "closed", kind: "execution_status", phase: "closed" }],
    outputStatus: { state: "failed" }
  }} />);
  expect(screen.getByTestId("tool-activity-disclosure").querySelector("summary"))
    .toHaveTextContent("File export failed");
  openProcess();
  expect(screen.getByText("Some generated files could not be prepared for download.")).toBeVisible();
  expect(screen.queryByText("Workspace execution ended")).not.toBeInTheDocument();
  rerender(<AnswerProcessV2 workspaceActivity={{ entries: [
    { id: "unknown", kind: "execution_status", phase: "unknown" }
  ] }} />);
  expect(screen.getByTestId("tool-activity-disclosure").querySelector("summary"))
    .toHaveTextContent("Cleanup unconfirmed");
  expect(screen.getByText("Workspace cleanup unconfirmed")).toBeVisible();
});
