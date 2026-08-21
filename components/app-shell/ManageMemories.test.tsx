import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManageMemories } from "./ManageMemories";
import { useMemoryManagerStore } from "./memoryManagerStore";
import { memoryConsumerItemFixture } from "@/tests/support/memoryFixtures";
import { resetMemoryManagerStoreForTest } from "@/tests/support/appShellStores";

const props = {
  accountId: "account-test",
  onBack: vi.fn(),
  useMemoryFacts: true
};

describe("ManageMemories", () => {
  beforeEach(() => {
    resetMemoryManagerStoreForTest();
    props.onBack.mockReset();
  });

  afterEach(() => {
    cleanup();
    resetMemoryManagerStoreForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows friendly saved and learned summaries without control-plane fields", async () => {
    const saved = memoryConsumerItemFixture();
    const learned = memoryConsumerItemFixture({
      category: "WORK",
      memoryRef: "opaque-learned-ref",
      provenance: "LEARNED",
      statement: "I am preparing a release plan."
    });
    useMemoryManagerStore.setState({
      accountId: "account-test",
      listLoadState: "ready",
      memories: [saved, learned]
    });
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      items: [learned],
      nextCursor: null
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ManageMemories {...props} />);

    expect(await screen.findByRole("heading", { name: "Manage Memories" })).toBeVisible();
    expect(screen.getAllByText("Saved by you").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Learned from chat").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Preferences").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Work").length).toBeGreaterThan(0);
    expect(screen.queryByText("Sensitive", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Sensitive information" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Edit: ${saved.statement}` })).toBeVisible();
    expect(screen.getByRole("button", { name: `Forget: ${learned.statement}` })).toBeVisible();
    expect(screen.queryByText(/index|version|scope|generation|embedding|fingerprint|score/iu))
      .not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Source" }), {
      target: { value: "LEARNED" }
    });
    await waitFor(() => expect(screen.queryByText(saved.statement)).not.toBeInTheDocument());
    expect(screen.getByText(learned.statement)).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/me/memories?pageSize=20&provenance=LEARNED",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("keeps manual create to one statement and server-side classification", async () => {
    useMemoryManagerStore.setState({ accountId: "account-test", listLoadState: "ready" });
    render(<ManageMemories {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Add memory" }));

    expect(await screen.findByRole("heading", { name: "Save a new memory" })).toBeVisible();
    expect(screen.getByLabelText("Exact statement")).toBeVisible();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.queryByLabelText("Kind")).not.toBeInTheDocument();
    expect(screen.getByText(/categorize this statement and check that it is safe/u)).toBeVisible();
    expect(screen.getByText(/may normalize this statement before saving/u)).toBeVisible();
    expect(screen.queryByText(/stores this text exactly as entered/u)).not.toBeInTheDocument();
  });

  it("renders classifier outages as a friendly unavailable state", async () => {
    useMemoryManagerStore.setState({
      accountId: "account-test",
      listLoadState: "ready",
      mutationError: "memory_unavailable",
      screen: "create"
    });
    render(<ManageMemories {...props} />);

    expect(await screen.findByRole("alert"))
      .toHaveTextContent("Memory is temporarily unavailable");
    expect(screen.getByRole("alert")).not.toHaveTextContent("classifier");
  });

  it("preserves a dirty draft until explicitly discarded", async () => {
    const onDirtyChange = vi.fn();
    useMemoryManagerStore.setState({ accountId: "account-test", listLoadState: "ready" });
    render(<ManageMemories {...props} onDirtyChange={onDirtyChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Add memory" }));
    const statement = await screen.findByLabelText("Exact statement");
    fireEvent.change(statement, { target: { value: "Keep this exact draft" } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByRole("button", { name: "Back to Memory settings" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Discard Memory draft?");
    expect(props.onBack).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(statement).toHaveValue("Keep this exact draft");
    fireEvent.click(screen.getByRole("button", { name: "Back to Memory settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(props.onBack).toHaveBeenCalledOnce();
  });

  it("renders only server-allowed item actions and no raw item ref", async () => {
    const memory = memoryConsumerItemFixture({
      category: "GOALS",
      memoryRef: "opaque-do-not-render",
      provenance: "LEARNED",
    });
    useMemoryManagerStore.setState({
      accountId: "account-test",
      activeMemory: memory,
      draft: { statement: memory.statement },
      listLoadState: "ready",
      memories: [memory],
      screen: "detail"
    });

    render(<ManageMemories {...props} />);

    expect(await screen.findByRole("heading", { name: "Memory detail" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Forget" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Correct" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Not relevant" })).not.toBeInTheDocument();
    expect(screen.queryByText("opaque-do-not-render")).not.toBeInTheDocument();
    expect(screen.queryByText("Sensitivity", { exact: true })).not.toBeInTheDocument();
  });

  it("shows a friendly unavailable-source state with no source identifiers", async () => {
    const memory = memoryConsumerItemFixture({
      memoryRef: "opaque-orphan-ref",
      provenance: "LEARNED",
      sourceAvailable: false
    });
    useMemoryManagerStore.setState({
      accountId: "account-test",
      activeMemory: memory,
      draft: { statement: memory.statement },
      listLoadState: "ready",
      memories: [memory],
      screen: "detail"
    });

    render(<ManageMemories {...props} />);

    expect((await screen.findAllByText("Source unavailable")).length).toBeGreaterThan(0);
    expect(screen.queryByText("opaque-orphan-ref")).not.toBeInTheDocument();
  });
});
