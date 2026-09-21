import { afterEach, describe, expect, it, vi } from "vitest";
import { activateArtifactLibraryAccount, decodeArtifactLibraryItems, mutateArtifactLibrary, refreshArtifactLibrary, useArtifactLibraryStore } from "./artifactLibraryStore";

const item = { id: "artifact", title: "Chart", kind: "chart", currentVersionId: "version", sourceChatId: "chat", publicationCount: 1,
  updatedAt: "2026-09-21T00:00:00.000Z", version: { versionNumber: 1 } };
afterEach(() => { activateArtifactLibraryAccount(null); localStorage.clear(); vi.unstubAllGlobals(); });
describe("artifact library cache", () => {
  it("clears only the successfully deleted artifact's local saved state", async () => {
    localStorage.setItem("aiqsa.artifact.state.artifact", "progress");
    localStorage.setItem("aiqsa.artifact.state.other", "keep");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ deleted: true })).mockResolvedValueOnce(Response.json({ artifacts: [] })));
    activateArtifactLibraryAccount("account");
    await expect(mutateArtifactLibrary("artifact", "delete")).rejects.toThrow();
    expect(localStorage.getItem("aiqsa.artifact.state.artifact")).toBe("progress");
    await mutateArtifactLibrary("artifact", "delete");
    expect(localStorage.getItem("aiqsa.artifact.state.artifact")).toBeNull();
    expect(localStorage.getItem("aiqsa.artifact.state.other")).toBe("keep");
  });

  it("duplicates an owned artifact, refreshes and places the returned copy first without duplicates", async () => {
    const copy = { ...item, id: "copy", title: "Copy of Chart", sourceChatId: null, publicationCount: 0 };
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ artifact: copy }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ artifacts: [item, copy] }));
    vi.stubGlobal("fetch", fetch);
    activateArtifactLibraryAccount("account");
    await expect(mutateArtifactLibrary(item.id, "duplicate")).resolves.toEqual(copy);
    expect(fetch.mock.calls[0]).toEqual(["/api/artifacts/artifact/duplicate", expect.objectContaining({ method: "POST" })]);
    expect(useArtifactLibraryStore.getState().data.recent?.map(value => value.id)).toEqual(["copy", "artifact"]);
  });
  it("loads recent and archived on demand, retaining rows when refresh fails", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ artifacts: [item] }))
      .mockResolvedValueOnce(Response.json({ artifacts: [] })).mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    activateArtifactLibraryAccount("account");
    await refreshArtifactLibrary();
    await refreshArtifactLibrary();
    expect(fetch).toHaveBeenCalledTimes(1);
    await refreshArtifactLibrary(true);
    expect(useArtifactLibraryStore.getState().data.archived).toEqual([]);
    await refreshArtifactLibrary(false, true);
    expect(useArtifactLibraryStore.getState()).toMatchObject({ loadState: { recent: "error" }, data: { recent: [item] } });
  });
  it("ignores an old account response and reports malformed data separately from empty", async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }))
      .mockResolvedValueOnce(Response.json({ artifacts: [{ ...item, updatedAt: "invalid" }] }));
    vi.stubGlobal("fetch", fetch);
    activateArtifactLibraryAccount("first");
    const old = refreshArtifactLibrary();
    activateArtifactLibraryAccount("second");
    resolve(Response.json({ artifacts: [item] }));
    await old;
    expect(useArtifactLibraryStore.getState().data.recent).toBeNull();
    await refreshArtifactLibrary();
    expect(useArtifactLibraryStore.getState().loadState.recent).toBe("error");
    expect(useArtifactLibraryStore.getState().data.recent).toBeNull();
    expect(() => decodeArtifactLibraryItems([{ ...item, sourceChatId: "\nprivate" }])).toThrow();
  });
  it("does not let a pending pre-mutation read replace the new list", async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }))
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(Response.json({ artifacts: [{ ...item, title: "Updated" }] }));
    vi.stubGlobal("fetch", fetch);
    activateArtifactLibraryAccount("account");
    const old = refreshArtifactLibrary();
    await mutateArtifactLibrary(item.id, { title: "Updated" });
    resolve(Response.json({ artifacts: [item] }));
    await old;
    expect(useArtifactLibraryStore.getState().data.recent?.[0]?.title).toBe("Updated");
    expect(useArtifactLibraryStore.getState().mutations[item.id]).toBe(false);
  });
});
