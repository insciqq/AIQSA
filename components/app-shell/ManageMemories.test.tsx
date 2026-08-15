import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManageMemories } from "./ManageMemories";
import {
  resetMemoryManagerStoreForTest,
  useMemoryManagerStore
} from "./memoryManagerStore";
import {
  memoryDeletionFixture,
  memoryDetailFixture,
  memoryEvidenceFixture,
  memorySummaryFixture
} from "./memoryTestFixtures";
import { resetWorkspaceStoreForTest, useWorkspaceStore } from "./workspaceStore";

const sourceProps = {
  accountId: "account-test",
  onOpenMemorySource: () => undefined
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status
  });
}

describe("ManageMemories", () => {
  beforeEach(() => {
    resetMemoryManagerStoreForTest();
    resetWorkspaceStoreForTest();
  });
  afterEach(() => {
    cleanup();
    resetMemoryManagerStoreForTest();
    resetWorkspaceStoreForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders a responsive evidence ledger and preserves a dirty edit before leaving", async () => {
    const memory = memorySummaryFixture();
    useMemoryManagerStore.setState({
      listLoadState: "ready",
      memories: [memory],
      nextCursor: null
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/evidence")) return json(memoryEvidenceFixture());
      if (path === `/api/me/memories/${memory.id}`) return json(memoryDetailFixture(memory));
      throw new Error(`unexpected request: ${path}`);
    }));
    const onBack = vi.fn();
    const onDirtyChange = vi.fn();
    render(
      <ManageMemories
        {...sourceProps}
        onBack={onBack}
        onDirtyChange={onDirtyChange}
        useMemoryFacts
      />
    );

    const listPane = screen.getByTestId("memory-list-pane");
    const detailPane = screen.getByTestId("memory-detail-pane");
    expect(listPane.parentElement).toHaveClass("block");
    expect(detailPane).toHaveClass("hidden", "md:block");
    fireEvent.click(screen.getByRole("button", { name: /I prefer concise answers in Russian/u }));

    expect(await screen.findByRole("heading", { name: "Memory detail" })).toBeVisible();
    expect(screen.getAllByText("I prefer concise answers in Russian.", { selector: "p" }).length)
      .toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("heading", { name: "Evidence history" })).toBeVisible();
    expect(screen.getByText("Explicit user action")).toBeVisible();
    expect(screen.getAllByText("memory-version-1", { exact: false }).length).toBeGreaterThanOrEqual(1);
    expect(detailPane).toHaveClass("block");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const statement = screen.getByLabelText("Exact statement");
    fireEvent.change(statement, { target: { value: "Keep this exact draft" } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    expect(screen.getByRole("button", { name: "New memory" })).toBeDisabled();
    expect(listPane.parentElement).toHaveAttribute("inert");
    fireEvent.click(screen.getByRole("button", { name: "Back to Memory settings" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Discard Memory draft?");
    expect(onBack).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(statement).toHaveValue("Keep this exact draft");
    fireEvent.click(screen.getByRole("button", { name: "Back to Memory settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("keeps raw chats and accepted runs explicit in the exact bulk confirmation", () => {
    useMemoryManagerStore.setState({ listLoadState: "ready", screen: "list" });
    render(<ManageMemories {...sourceProps} onBack={vi.fn()} useMemoryFacts />);

    fireEvent.click(screen.getByRole("button", { name: "Delete all saved memories" }));

    expect(screen.getByRole("heading", { name: "Delete all saved memories?" })).toBeVisible();
    expect(screen.getByText(/stop being used immediately/u)).toBeVisible();
    fireEvent.click(screen.getByText("What is and is not deleted").closest("summary")!);
    expect(screen.getByText(/Retained raw chats are not deleted/u)).toBeVisible();
    expect(screen.getByText(/immutable accepted destination runs are not rewritten/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete all saved memories" })).toBeVisible();
  });

  it("forgets one exact memory immediately and restores it through bounded Undo", async () => {
    const memory = memorySummaryFixture();
    const undoExpiresAt = new Date(Date.now() + 30_000).toISOString();
    const forgotten = memorySummaryFixture({
      currentVersionId: null,
      displayText: null,
      factState: "FORGOTTEN",
      versionState: "FORGOTTEN"
    });
    useMemoryManagerStore.setState({
      activeMemory: memory,
      detailLoadState: "ready",
      draft: {
        category: memory.category,
        modality: memory.modality,
        scope: memory.scope,
        statement: memory.displayText ?? ""
      },
      listLoadState: "ready",
      memories: [memory],
      screen: "detail",
      versions: memoryDetailFixture(memory).versions
    });
    let authorizationCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/me/memory/mutation-authorizations") {
        authorizationCount += 1;
        return json({
          expiresAt: "2099-08-11T08:00:00.000Z",
          mutationAuthorizationId: authorizationCount === 1 ? "forget-auth" : "restore-auth"
        });
      }
      if (path.endsWith("/forget")) {
        return json({
          memory: forgotten,
          undo: {
            deletionId: "forget-deletion-1",
            expiresAt: undoExpiresAt,
            versionId: "memory-version-1"
          }
        });
      }
      if (path.endsWith("/undo-forget")) return json({ memory });
      if (path.startsWith("/api/me/memories?")) {
        return json({ memories: authorizationCount >= 2 ? [memory] : [], nextCursor: null });
      }
      throw new Error(`unexpected request: ${path}`);
    }));
    render(<ManageMemories {...sourceProps} onBack={vi.fn()} useMemoryFacts />);

    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    expect(await screen.findByText("Forgotten.")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Forget this memory?" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Memory restored.")).toBeVisible();
    expect(useMemoryManagerStore.getState().memories).toContainEqual(memory);
  });

  it("renders blocked durable deletion without exposing memory text", async () => {
    const memory = memorySummaryFixture({ displayText: "private value must stay absent" });
    useMemoryManagerStore.setState({ listLoadState: "ready", memories: [memory] });
    render(<ManageMemories {...sourceProps} onBack={vi.fn()} useMemoryFacts />);
    act(() => {
      useMemoryManagerStore.setState({
        deletionLoadState: "ready",
        deletionStatus: memoryDeletionFixture({
          completedUnits: 2,
          state: "BLOCKED_REQUIRES_ADMIN"
        }),
        screen: "delete"
      });
    });

    expect(await screen.findByRole("heading", { name: "Durable deletion progress" })).toBeVisible();
    expect(screen.getByText(/physical deletion needs administrator attention/u)).toBeVisible();
    expect(screen.getByText("2 / 4", { exact: false })).toBeVisible();
    expect(screen.queryByText("private value must stay absent")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check deletion status" })).toBeVisible();
  });

  it("uses one local Settings scroll owner instead of nested list/detail scrollers", () => {
    useMemoryManagerStore.setState({ listLoadState: "ready" });
    render(<ManageMemories {...sourceProps} onBack={vi.fn()} useMemoryFacts={false} />);

    const manager = screen.getByTestId("manage-memories");
    expect(manager.querySelectorAll(".overflow-y-auto")).toHaveLength(0);
    expect(within(manager).getByRole("heading", { name: "Manage Memories" })).toBeVisible();
  });

  it("enters and returns from distinct history search with deterministic focus", async () => {
    useMemoryManagerStore.setState({ listLoadState: "ready" });
    render(<ManageMemories {...sourceProps} onBack={vi.fn()} useMemoryFacts />);

    const entry = screen.getByRole("button", { name: "Search chat history" });
    expect(entry).toHaveTextContent("Recover an earlier passage or decision");
    fireEvent.click(entry);
    const heading = screen.getByRole("heading", { name: "Search chat history" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.queryByRole("heading", { name: "Manage Memories" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to saved memories" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Search chat history" })).toHaveFocus());
    expect(screen.getByRole("heading", { name: "Manage Memories" })).toBeVisible();
  });

  it("creates with a reachable Global, folder, chat, and archived-chat scope picker", async () => {
    useMemoryManagerStore.setState({ listLoadState: "ready" });
    useWorkspaceStore.setState({
      chats: [{
        activeLeafMessageId: null,
        createdAt: "2026-08-10T08:00:00.000Z",
        defaultModelId: "model",
        defaultProvider: "provider",
        folderId: null,
        id: "chat-live",
        memoryMode: "NORMAL",
        messageCount: 1,
        title: "Live chat",
        updatedAt: "2026-08-10T08:00:00.000Z"
      }],
      folders: [{
        id: "folder-live",
        name: "Research",
        parentId: null,
        projectMemory: "",
        sortOrder: 0
      }]
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/me/assistants") {
        return json({
          assistants: [],
          publishableGroups: [],
          viewer: { canPublishInstallation: false }
        });
      }
      if (String(input) === "/api/chats/archived") {
        return json({
          chats: [{
            activeLeafMessageId: "message-1",
            archived: true,
            createdAt: "2026-08-10T08:00:00.000Z",
            defaultKnowledgePlan: null,
            defaultModelId: null,
            defaultProvider: null,
            folderId: null,
            id: "chat-archived",
            memoryMode: "NORMAL",
            messageCount: 1,
            pinned: false,
            sourceRevision: 2,
            title: "Archived chat",
            updatedAt: "2026-08-10T08:00:00.000Z"
          }],
          nextCursor: null
        });
      }
      throw new Error(`unexpected request: ${String(input)}`);
    }));
    render(<ManageMemories {...sourceProps} onBack={vi.fn()} useMemoryFacts />);

    fireEvent.click(screen.getByRole("button", { name: "New memory" }));
    const scope = screen.getByRole("combobox", { name: "Scope" });
    expect(scope).toHaveValue("GLOBAL_USER");
    expect(await screen.findByRole("option", { name: "Archived chat (archived)" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Research" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Live chat" })).toBeVisible();

    fireEvent.change(scope, { target: { value: "FOLDER:folder-live" } });
    expect(useMemoryManagerStore.getState().draft.scope).toEqual({
      targetId: "folder-live",
      type: "FOLDER"
    });
  });

  it("records automatic-memory feedback immediately and exposes append-only Undo", async () => {
    const automatic = memorySummaryFixture({ sourceMode: "AUTOMATIC" });
    const writes: Record<string, unknown>[] = [];
    let feedbackWrites = 0;
    useMemoryManagerStore.setState({
      activeMemory: automatic,
      detailLoadState: "ready",
      draft: {
        category: automatic.category,
        modality: automatic.modality,
        scope: automatic.scope,
        statement: automatic.displayText ?? ""
      },
      evidenceLoadState: "ready",
      listLoadState: "ready",
      memories: [automatic],
      screen: "detail",
      versions: memoryDetailFixture(automatic).versions
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/feedback")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        writes.push(body);
        feedbackWrites += 1;
        return feedbackWrites === 1
          ? json({
              createdAt: "2026-08-11T08:00:00.000Z",
              feedbackId: "feedback-1",
              feedbackType: "INCORRECT",
              retractedFeedbackId: null,
              targetVersionId: "memory-version-1"
            }, 201)
          : json({
              createdAt: "2026-08-11T08:01:00.000Z",
              feedbackId: "feedback-retract-1",
              feedbackType: "RETRACT",
              retractedFeedbackId: "feedback-1",
              targetVersionId: "memory-version-1"
            }, 201);
      }
      if (path === `/api/me/memories/${automatic.id}`) {
        return json(memoryDetailFixture(automatic));
      }
      if (path === "/api/me/assistants") {
        return json({ assistants: [], publishableGroups: [], viewer: { canPublishInstallation: false } });
      }
      if (path === "/api/chats/archived") return json({ chats: [], nextCursor: null });
      throw new Error(`unexpected request: ${path}`);
    }));
    render(<ManageMemories {...sourceProps} onBack={vi.fn()} useMemoryFacts />);

    fireEvent.change(screen.getByLabelText("Private note (optional)"), {
      target: { value: "  Wrong inference  " }
    });
    fireEvent.click(screen.getByRole("button", { name: "This is incorrect" }));

    expect(await screen.findByText("Private Memory feedback recorded.")).toBeVisible();
    expect(writes[0]).toMatchObject({
      comment: "Wrong inference",
      expectedVersionId: "memory-version-1",
      feedbackType: "INCORRECT"
    });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Memory feedback undone.")).toBeVisible();
    expect(writes[1]).toMatchObject({
      expectedVersionId: "memory-version-1",
      feedbackType: "RETRACT",
      retractsFeedbackId: "feedback-1"
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps a typed correction after a stale conflict reload without adding confirmation", async () => {
    const conflicted = memorySummaryFixture({
      actionVersionId: "version-a",
      currentVersionId: null,
      factState: "CONFLICTED",
      sourceMode: "AUTOMATIC",
      versionState: "CONFLICTING"
    });
    const versions = ["version-a", "version-b"].map((id, index) => ({
      category: "preference",
      createdAt: `2026-08-11T07:0${index}:00.000Z`,
      displayText: index === 0 ? "Keep answers concise." : "Use detailed answers.",
      id,
      modality: "PREFERENCE" as const,
      sensitivityClass: "NORMAL" as const,
      sourceCount: 1,
      sourceMode: "AUTOMATIC" as const,
      state: "CONFLICTING" as const,
      systemFrom: `2026-08-11T07:0${index}:00.000Z`,
      systemTo: null,
      validFrom: null,
      validTo: null
    }));
    const calls: Array<{ body: Record<string, unknown>; path: string }> = [];
    useMemoryManagerStore.setState({
      activeMemory: conflicted,
      detailLoadState: "ready",
      evidenceLoadState: "ready",
      listLoadState: "ready",
      memories: [conflicted],
      screen: "detail",
      versions
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      calls.push({ body, path });
      if (path === "/api/me/memory/mutation-authorizations") {
        return json({
          expiresAt: "2026-08-11T08:05:00.000Z",
          mutationAuthorizationId: "authorization-resolve"
        }, 201);
      }
      if (path.endsWith("/resolve")) return json({ error: "memory_version_stale" }, 409);
      if (path === `/api/me/memories/${conflicted.id}`) {
        return json({ ...memoryDetailFixture(conflicted), versions });
      }
      if (path === "/api/me/assistants") {
        return json({ assistants: [], publishableGroups: [], viewer: { canPublishInstallation: false } });
      }
      if (path === "/api/chats/archived") return json({ chats: [], nextCursor: null });
      throw new Error(`unexpected request: ${path}`);
    }));
    render(<ManageMemories {...sourceProps} onBack={vi.fn()} useMemoryFacts />);

    expect(screen.queryByRole("button", { name: "Move scope" })).not.toBeInTheDocument();

    const correction = screen.getByLabelText("Correct value");
    fireEvent.change(correction, { target: { value: "Keep my exact local correction." } });
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));

    await waitFor(() => {
      expect(calls.some(({ path }) => path.endsWith("/resolve"))).toBe(true);
      expect(useMemoryManagerStore.getState().mutationState).toBeNull();
    });
    expect(correction).toHaveValue("Keep my exact local correction.");
    expect(calls.find(({ path }) => path.endsWith("/resolve"))?.body).toMatchObject({
      expectedVersionIds: ["version-a", "version-b"],
      resolution: { kind: "CORRECT", statement: "Keep my exact local correction." }
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("makes ORPHANED scope repair and Forget explicit while hiding ordinary edit controls", async () => {
    const orphaned = memorySummaryFixture({
      actionVersionId: "memory-version-orphaned",
      currentVersionId: null,
      factState: "ORPHANED",
      scope: { targetId: "chat-gone", type: "CHAT" },
      versionState: "ORPHANED"
    });
    useMemoryManagerStore.setState({
      activeMemory: orphaned,
      detailLoadState: "ready",
      draft: {
        category: orphaned.category,
        modality: orphaned.modality,
        scope: orphaned.scope,
        statement: orphaned.displayText ?? ""
      },
      listLoadState: "ready",
      memories: [orphaned],
      screen: "detail"
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/api/me/assistants"
        ? json({ assistants: [], publishableGroups: [], viewer: { canPublishInstallation: false } })
        : json({ chats: [], nextCursor: null })
    ));
    render(<ManageMemories {...sourceProps} onBack={vi.fn()} useMemoryFacts />);

    expect(screen.getByText("Source or scope unavailable.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pin" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Forget" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Move scope" }));

    expect(await screen.findByRole("heading", { name: "Move memory scope" })).toBeVisible();
    expect(screen.getByText(/prior record remains as historical move evidence/)).toBeVisible();
    expect(screen.getByText(/Choose an available scope to repair it/)).toBeVisible();
  });
});
