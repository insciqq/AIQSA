import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMemorySearch,
  beginCreateMemory,
  beginEditMemory,
  cancelMemoryDraft,
  deactivateMemoryManager,
  forgetCurrentMemory,
  invalidateMemoryManagerData,
  openMemoryDetail,
  openMemoryManager,
  refreshMemoryList,
  requestForgetMemory,
  saveMemoryChanges,
  saveNewMemory,
  useMemoryManagerStore
} from "./memoryManagerStore";
import {
  memoryConsumerItemFixture,
  memoryConsumerListFixture
} from "@/tests/support/memoryFixtures";
import { resetMemoryManagerStoreForTest } from "@/tests/support/appShellStores";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

describe("Memory manager store", () => {
  beforeEach(() => resetMemoryManagerStoreForTest());

  afterEach(() => {
    vi.useRealTimers();
    resetMemoryManagerStoreForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads and searches only safe item summaries", async () => {
    const first = memoryConsumerItemFixture();
    const found = memoryConsumerItemFixture({
      memoryRef: "opaque-found-ref",
      provenance: "LEARNED",
      statement: "I am learning Russian."
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(memoryConsumerListFixture([first])))
      .mockResolvedValueOnce(json(memoryConsumerListFixture([found])));
    vi.stubGlobal("fetch", fetchMock);

    await openMemoryManager("account-1");
    expect(useMemoryManagerStore.getState().memories).toEqual([first]);

    useMemoryManagerStore.getState().setQueryInput("Russian");
    await applyMemorySearch();
    expect(useMemoryManagerStore.getState()).toMatchObject({
      memories: [found],
      queryApplied: "Russian"
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/me/memories/search");
  });

  it("creates a statement without client classification, scope, IDs, or hashes", async () => {
    const created = memoryConsumerItemFixture({ memoryRef: "opaque-created-ref" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ item: created }, 201))
      .mockResolvedValueOnce(json(memoryConsumerListFixture([created])));
    vi.stubGlobal("fetch", fetchMock);
    beginCreateMemory();
    useMemoryManagerStore.getState().setDraft({ statement: "I prefer concise answers." });

    await saveNewMemory(false);

    expect(useMemoryManagerStore.getState()).toMatchObject({
      activeMemory: created,
      draftDirty: false,
      notice: "saved_use_off",
      screen: "detail"
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({ statement: "I prefer concise answers." });
    expect(body.requestId).toMatch(/^[a-f0-9]{48}$/u);
    expect(JSON.stringify(body)).not.toMatch(/category|scope|factId|version|hash|authorization/iu);
  });

  it("edits through an opaque ref and preserves a stale draft", async () => {
    const memory = memoryConsumerItemFixture({ memoryRef: "opaque/edit-ref" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "memory_changed" }, 409)));
    useMemoryManagerStore.setState({
      activeMemory: memory,
      listLoadState: "ready",
      memories: [memory],
      screen: "detail"
    });
    beginEditMemory();
    useMemoryManagerStore.getState().setDraft({ statement: "Keep this revised statement." });

    await expect(saveMemoryChanges()).rejects.toThrow("memory_changed");

    expect(useMemoryManagerStore.getState()).toMatchObject({
      draft: { statement: "Keep this revised statement." },
      draftDirty: true,
      draftStale: true,
      mutationOutcomeUnknown: false,
      screen: "edit"
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/me/memories/opaque%2Fedit-ref",
      expect.objectContaining({ method: "PATCH" })
    );
  });

  it("forgets an allowed item and removes it from local results", async () => {
    const memory = memoryConsumerItemFixture({ memoryRef: "opaque-forget-ref" });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json({ status: "FORGOTTEN" }))
      .mockResolvedValueOnce(json(memoryConsumerListFixture([]))));
    useMemoryManagerStore.setState({
      listLoadState: "ready",
      memories: [memory]
    });
    openMemoryDetail(memory.memoryRef);

    await forgetCurrentMemory();

    expect(useMemoryManagerStore.getState()).toMatchObject({
      activeMemory: null,
      memories: [],
      notice: "forgotten",
      screen: "list"
    });
  });

  it("ignores actions not granted by the server", async () => {
    const memory = memoryConsumerItemFixture({ allowedActions: [] });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    useMemoryManagerStore.setState({
      activeMemory: memory,
      listLoadState: "ready",
      memories: [memory],
      screen: "detail"
    });

    beginEditMemory();
    await forgetCurrentMemory();

    expect(useMemoryManagerStore.getState().screen).toBe("detail");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens inline Forget only for the exact server-authorized item", () => {
    const allowed = memoryConsumerItemFixture({ memoryRef: "opaque-allowed" });
    const denied = memoryConsumerItemFixture({
      allowedActions: ["EDIT"],
      memoryRef: "opaque-denied"
    });
    useMemoryManagerStore.setState({
      listLoadState: "ready",
      memories: [allowed, denied]
    });

    requestForgetMemory(denied.memoryRef);
    expect(useMemoryManagerStore.getState().screen).toBe("list");
    requestForgetMemory("opaque-missing");
    expect(useMemoryManagerStore.getState().screen).toBe("list");

    requestForgetMemory(allowed.memoryRef);
    expect(useMemoryManagerStore.getState()).toMatchObject({
      activeMemory: allowed,
      draftDirty: false,
      screen: "forget"
    });
  });

  it("drops prior-account data before loading the next account", async () => {
    const first = memoryConsumerItemFixture();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json(memoryConsumerListFixture([first])))
      .mockResolvedValueOnce(json(memoryConsumerListFixture([]))));
    await openMemoryManager("account-1");
    await openMemoryManager("account-2");

    expect(useMemoryManagerStore.getState()).toMatchObject({
      accountId: "account-2",
      memories: [],
      listLoadState: "ready"
    });
  });

  it.each(["before", "after"])("preserves an edit when a search returns %s its acknowledgement", async (timing) => {
    const original = memoryConsumerItemFixture({ memoryRef: "old-ref", statement: "The east gate." });
    const rotated = { ...original, memoryRef: "rotated-ref" };
    const updated = { ...original, memoryRef: "updated-ref", statement: "The west gate." };
    let resolveSearch!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveSearch = resolve; }))
      .mockResolvedValueOnce(json({ item: updated }))
      .mockResolvedValueOnce(json(memoryConsumerListFixture([updated]))));
    useMemoryManagerStore.setState({ memories: [original], listLoadState: "ready" });
    const search = refreshMemoryList({ appliedQuery: "gate" });
    openMemoryDetail(original.memoryRef);
    beginEditMemory();
    useMemoryManagerStore.getState().setDraft({ statement: updated.statement });
    if (timing === "before") {
      resolveSearch(json(memoryConsumerListFixture([rotated])));
      await search;
      expect(useMemoryManagerStore.getState().memories).toEqual([original]);
    }
    await saveMemoryChanges();
    if (timing === "after") {
      resolveSearch(json(memoryConsumerListFixture([rotated])));
      await search;
    }
    expect(useMemoryManagerStore.getState()).toMatchObject({
      activeMemory: updated, memories: [updated], notice: "saved", listLoadState: "ready"
    });
  });

  it("keeps an acknowledged edit and the last known rows when reloading the list keeps failing", async () => {
    vi.useFakeTimers();
    const original = memoryConsumerItemFixture();
    const updated = { ...original, memoryRef: "updated-ref", statement: "Changed." };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ item: updated }))
      .mockRejectedValue(new TypeError("offline"));
    vi.stubGlobal("fetch", fetchMock);
    useMemoryManagerStore.setState({ activeMemory: original, memories: [original] });
    beginEditMemory();
    useMemoryManagerStore.getState().setDraft({ statement: updated.statement });

    const saved = saveMemoryChanges();
    await vi.advanceTimersByTimeAsync(7_000);
    await expect(saved).resolves.toBeUndefined();

    // One write and one read with at most three background retries.
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(useMemoryManagerStore.getState()).toMatchObject({
      memories: [updated], notice: "saved", mutationError: null, listLoadState: "error"
    });
  });

  it.each(["create", "edit", "forget"])("ignores a late %s acknowledgement after leaving the account", async (kind) => {
    const original = memoryConsumerItemFixture();
    let resolve!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
    vi.stubGlobal("fetch", fetchMock);
    useMemoryManagerStore.setState({ accountId: "old", activeMemory: original, memories: [original] });
    if (kind === "create") beginCreateMemory();
    else if (kind === "edit") beginEditMemory();
    useMemoryManagerStore.getState().setDraft({ statement: "Changed." });
    const pending = kind === "create" ? saveNewMemory(true)
      : kind === "edit" ? saveMemoryChanges() : forgetCurrentMemory();
    deactivateMemoryManager();
    useMemoryManagerStore.setState({ accountId: "new", memories: [] });
    resolve(json(kind === "forget" ? { status: "FORGOTTEN" } : { item: original }));
    await pending;

    expect(useMemoryManagerStore.getState()).toMatchObject({
      accountId: "new", memories: [], activeMemory: null, notice: null
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("deduplicates an appended page by opaque ref", async () => {
    const item = memoryConsumerItemFixture();
    useMemoryManagerStore.setState({
      listLoadState: "ready",
      memories: [item],
      nextCursor: "opaque-cursor"
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(
      memoryConsumerListFixture([item], null)
    )));

    await refreshMemoryList({ append: true });
    expect(useMemoryManagerStore.getState().memories).toEqual([item]);
  });

  it("clears the entire manager on reset and rejects a read started before it", async () => {
    const original = memoryConsumerItemFixture();
    let resolve!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
    vi.stubGlobal("fetch", fetchMock);
    useMemoryManagerStore.setState({ accountId: "owner", memories: [original], queryInput: "old", queryApplied: "old" });
    const oldRead = refreshMemoryList();
    beginCreateMemory();
    useMemoryManagerStore.getState().setDraft({ statement: "Unsaved detail" });

    invalidateMemoryManagerData("owner", true);
    beginCreateMemory();
    openMemoryDetail(original.memoryRef);
    requestForgetMemory(original.memoryRef);
    await saveNewMemory(true);
    await refreshMemoryList();
    resolve(json(memoryConsumerListFixture([original])));
    await oldRead;

    expect(useMemoryManagerStore.getState()).toMatchObject({
      accountId: "owner", memories: [], activeMemory: null, nextCursor: null,
      draft: { statement: "" }, draftDirty: false, queryInput: "", queryApplied: "",
      resetPending: true, screen: "list", listLoadState: "idle"
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    invalidateMemoryManagerData("previous-owner");
    expect(useMemoryManagerStore.getState().resetPending).toBe(true);
    invalidateMemoryManagerData("owner");
    expect(useMemoryManagerStore.getState().resetPending).toBe(false);
  });

  it.each(["create", "edit", "forget"])("reconciles an unknown %s outcome silently with a fresh read", async (kind) => {
    const original = memoryConsumerItemFixture();
    const committed = { ...original, memoryRef: "committed-ref", statement: "Changed." };
    let finishRead!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("lost_acknowledgement"))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishRead = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    useMemoryManagerStore.setState({ activeMemory: original, memories: [original], listLoadState: "ready" });
    if (kind === "create") beginCreateMemory();
    else if (kind === "edit") beginEditMemory();
    else requestForgetMemory(original.memoryRef);
    useMemoryManagerStore.getState().setDraft({ statement: "Changed." });
    const submit = () => kind === "create" ? saveNewMemory(true)
      : kind === "edit" ? saveMemoryChanges() : forgetCurrentMemory();

    const pending = submit();
    // The read runs while the editor keeps its draft; no new write starts.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "GET" });
    expect(useMemoryManagerStore.getState()).toMatchObject({
      draft: { statement: "Changed." }, mutationError: null, mutationOutcomeUnknown: true, mutationState: null
    });
    await submit();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    finishRead(json(memoryConsumerListFixture(kind === "forget" ? [] : [committed])));
    await expect(pending).rejects.toThrow("lost_acknowledgement");
    expect(useMemoryManagerStore.getState()).toMatchObject({
      memories: kind === "forget" ? [] : [committed],
      mutationError: null, mutationOutcomeUnknown: false, listLoadState: "ready",
      // The edited or forgotten target no longer exists, so its editor closes;
      // a new draft keeps its editor and text.
      ...(kind === "create"
        ? { draft: { statement: "Changed." }, screen: "create" }
        : { activeMemory: null, screen: "list" })
    });
  });

  it("keeps the editor and draft when the target still exists after a failed edit", async () => {
    const original = memoryConsumerItemFixture();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: "memory_action_failed" }, 500))
      .mockResolvedValueOnce(json(memoryConsumerListFixture([original])));
    vi.stubGlobal("fetch", fetchMock);
    useMemoryManagerStore.setState({ activeMemory: original, memories: [original], listLoadState: "ready" });
    beginEditMemory();
    useMemoryManagerStore.getState().setDraft({ statement: "My draft." });

    await expect(saveMemoryChanges()).rejects.toThrow("memory_action_failed");

    expect(useMemoryManagerStore.getState()).toMatchObject({
      activeMemory: original, draft: { statement: "My draft." }, draftDirty: true,
      mutationError: null, mutationOutcomeUnknown: false, notice: null, screen: "edit"
    });
    fetchMock.mockResolvedValueOnce(json({ item: { ...original, statement: "My draft." } }))
      .mockResolvedValueOnce(json(memoryConsumerListFixture([original])));
    await saveMemoryChanges();
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "PATCH" });
    expect(useMemoryManagerStore.getState().notice).toBe("saved");
  });

  it("keeps a secret rejection visible as input validation", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ error: "memory_secret_rejected" }, 422));
    vi.stubGlobal("fetch", fetchMock);
    beginCreateMemory();
    useMemoryManagerStore.getState().setDraft({ statement: "token abc" });

    await expect(saveNewMemory(true)).rejects.toThrow("memory_secret_rejected");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(useMemoryManagerStore.getState()).toMatchObject({
      mutationError: "memory_secret_rejected", mutationOutcomeUnknown: false, screen: "create"
    });
  });

  it("lifts the block after its reconciliation read keeps failing, without loading forever", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("offline"));
    vi.stubGlobal("fetch", fetchMock);
    beginCreateMemory();
    useMemoryManagerStore.getState().setDraft({ statement: "Keep the receipt." });
    const pending = saveNewMemory(true);
    const settled = expect(pending).rejects.toThrow("offline");
    await vi.advanceTimersByTimeAsync(7_000);
    await settled;

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(useMemoryManagerStore.getState()).toMatchObject({
      draft: { statement: "Keep the receipt." }, listLoadState: "error",
      mutationError: null, mutationOutcomeUnknown: false, screen: "create"
    });
  });

  it("sends category and provenance filters on every page", async () => {
    useMemoryManagerStore.setState({
      categoryFilter: "WORK",
      listLoadState: "ready",
      provenanceFilter: "LEARNED"
    });
    const fetchMock = vi.fn().mockResolvedValue(json(memoryConsumerListFixture([])));
    vi.stubGlobal("fetch", fetchMock);

    await refreshMemoryList();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/me/memories?pageSize=20&category=WORK&provenance=LEARNED",
      expect.objectContaining({ method: "GET" })
    );
  });
});
