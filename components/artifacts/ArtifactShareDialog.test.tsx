import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactDetail, ArtifactKind } from "@/lib/contracts/artifacts";
import { ArtifactShareDialog } from "./ArtifactShareDialog";

function detail(kind: ArtifactKind = "html"): ArtifactDetail {
  return { id: "artifact", title: "A small world", currentVersionId: "version", sourceChatId: "chat", publications: [],
    versions: [{ id: "version", title: "A small world", kind, versionNumber: 3, entrypoint: "index.html" }] };
}

describe("artifact sharing", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("publishes once, copies the one-time link, and confirms revocation", async () => {
    let settle!: (response: Response) => void;
    let artifact = detail();
    const clipboard = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText: clipboard } });
    const fetcher = vi.fn(async (path: string) => {
      if (path === "/api/artifacts/artifact") return Response.json({ artifact });
      if (path.endsWith("/publish")) return new Promise<Response>(resolve => { settle = resolve; });
      artifact = { ...artifact, publications: artifact.publications.map(item => ({ ...item, status: "REVOKED" })) };
      return Response.json({ revoked: true });
    });
    vi.stubGlobal("fetch", fetcher);
    const onClose = vi.fn();
    render(<ArtifactShareDialog artifactId="artifact" versionId="version" versionNumber={3} onClose={onClose} />);
    const dialog = await screen.findByRole("dialog", { name: "Share “A small world”" });
    expect(screen.getByText("No public links yet. This artifact is private.")).toBeVisible();
    expect(screen.queryByText(/Game progress/u)).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Link expires" }), { target: { value: "7" } });
    const publish = screen.getByRole("button", { name: "Publish v3" });
    expect(publish).toHaveAttribute("data-tone", "primary");
    fireEvent.click(publish); fireEvent.click(publish); fireEvent.keyDown(dialog, { key: "Escape" });
    expect(fetcher.mock.calls.filter(([path]) => path.endsWith("/publish"))).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
    artifact = { ...artifact, publications: [{ id: "publication", versionId: "version", status: "READY", createdAt: "2026-09-20T12:00:00.000Z", expiresAt: null }] };
    await act(async () => settle(Response.json({ publication: { id: "publication", publicPath: `/a/${"x".repeat(43)}` } })));
    const url = `${window.location.origin}/a/${"x".repeat(43)}`;
    expect(screen.getByRole("textbox", { name: "Public link" })).toHaveValue(url);
    expect(clipboard).toHaveBeenCalledWith(url);
    expect(screen.getByRole("status")).toHaveTextContent("Link copied");
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    expect(fetcher.mock.calls.filter(([path]) => path.endsWith("/revoke"))).toHaveLength(0);
    const confirm = screen.getByRole("button", { name: "Revoke link" });
    expect(confirm).toHaveAttribute("data-tone", "destructive");
    fireEvent.click(confirm); fireEvent.click(confirm);
    await screen.findByText("Link revoked. It can no longer be opened.");
    expect(screen.queryByRole("link", { name: "Open" })).not.toBeInTheDocument();
    expect(fetcher.mock.calls.filter(([path]) => path.endsWith("/revoke"))).toHaveLength(1);
  });

  it("keeps a generated link available when clipboard access fails", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("Denied")) } });
    vi.stubGlobal("fetch", vi.fn(async (path: string) => Response.json(path.endsWith("/publish")
      ? { publication: { id: "publication", publicPath: "/a/token" } } : { artifact: detail("game") })));
    render(<ArtifactShareDialog artifactId="artifact" versionId="version" versionNumber={3} onClose={() => {}} />);
    await screen.findByText("Game progress is saved in each viewer’s browser.");
    fireEvent.click(screen.getByRole("button", { name: "Publish v3" }));
    await screen.findByText("Copy the link now");
    expect(screen.getByRole("textbox", { name: "Public link" })).toHaveValue(`${window.location.origin}/a/token`);
    expect(screen.getByRole("button", { name: "Copy link" })).toBeEnabled();
  });

  it("distinguishes failed link loading from a private artifact and can retry", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValue(Response.json({ artifact: detail() }));
    vi.stubGlobal("fetch", fetcher);
    render(<ArtifactShareDialog artifactId="artifact" versionId="version" versionNumber={3} onClose={() => {}} />);
    await screen.findByText("Connection lost");
    expect(screen.queryByText("No public links yet. This artifact is private.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish v3" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("No public links yet. This artifact is private.");
    expect(screen.getByRole("button", { name: "Publish v3" })).toBeEnabled();
  });

  it("shows five recent publications, expiry and inactive states without exposing lost links", async () => {
    const artifact = detail();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ artifact: { ...artifact,
      publications: Array.from({ length: 7 }, (_, index) => ({ id: `publication-${index}`, versionId: "version", createdAt: `2026-09-${20 - index}T12:00:00.000Z`,
        expiresAt: index === 0 ? "2020-01-01T00:00:00.000Z" : null, status: index === 1 ? "REVOKED" : index === 2 ? "PENDING" : "READY" }))
    } })));
    render(<ArtifactShareDialog artifactId="artifact" versionId="version" versionNumber={3} onClose={() => {}} />);
    const links = await screen.findByRole("region", { name: "Published links" });
    await waitFor(() => expect(within(links).getAllByRole("listitem")).toHaveLength(5));
    expect(within(links).getByText("Expired")).toBeVisible();
    expect(within(links).getByText("Revoked")).toBeVisible();
    expect(within(links).getByText("Publishing")).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Public link" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show all (7)" }));
    expect(within(links).getAllByRole("listitem")).toHaveLength(7);
  });
});

function versionedDetail(): ArtifactDetail {
  return { ...detail(), currentVersionId: "v5", versions: [1, 3, 5, 6].map(versionNumber => ({
    id: `v${versionNumber}`, versionNumber, title: `Garden ${versionNumber}`, kind: "game", entrypoint: "index.html"
  })), publications: [{ id: "set", mode: "version_set", revision: 1, defaultVersionId: "v3", status: "READY",
    createdAt: "2026-09-20T12:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
    versions: [1, 3, 5].map(versionNumber => ({ id: `v${versionNumber}`, versionNumber, title: `Garden ${versionNumber}`, kind: "game", entrypoint: "index.html" })) }] };
}

describe("versioned artifact sharing", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("defaults to single-version and publishes only the explicitly chosen set and default", async () => {
    const artifact = { ...versionedDetail(), publications: [] };
    const fetcher = vi.fn(async (path: string) => path.endsWith("/publish")
      ? Response.json({ publication: { ...versionedDetail().publications[0], publicPath: "/a/created-set" } }) : Response.json({ artifact }));
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("Denied")) } });
    render(<ArtifactShareDialog artifactId="artifact" versionId="v1" versionNumber={1} onClose={() => {}} />);
    await screen.findByRole("dialog", { name: "Share “A small world”" });
    expect(screen.getByRole("radio", { name: "Single version" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Publish v1" })).toBeEnabled();
    fireEvent.click(screen.getByRole("radio", { name: "Version set" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Include v3" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Include v5" }));
    expect(screen.getByRole("checkbox", { name: "Include v6" })).not.toBeChecked();
    fireEvent.change(screen.getByRole("combobox", { name: "Default version" }), { target: { value: "v3" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Link expires" }), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish versions" }));
    await screen.findByText("Copy the link now");
    const request = (fetcher.mock.calls as unknown as [string, RequestInit][]).find(([path]) => path.endsWith("/publish"))!;
    expect(JSON.parse(request[1].body as string)).toEqual({ mode: "version_set", versionIds: ["v1", "v3", "v5"], defaultVersionId: "v3", expiresInDays: 7 });
    expect(screen.getByRole("textbox", { name: "Public link" })).toHaveValue(`${window.location.origin}/a/created-set`);
  });

  it("retains the opening version and one-time URL through a background version change", async () => {
    const artifact = versionedDetail();
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    vi.stubGlobal("fetch", vi.fn(async (path: string) => path.endsWith("/publish")
      ? Response.json({ publication: { id: "single", versionId: "v1", createdAt: "2026-09-21T00:00:00.000Z", expiresAt: null, status: "READY", publicPath: "/a/one-time" } })
      : Response.json({ artifact })));
    const { rerender } = render(<ArtifactShareDialog artifactId="artifact" versionId="v1" versionNumber={1} onClose={() => {}} />);
    await screen.findByRole("dialog", { name: "Share “A small world”" });
    fireEvent.click(screen.getByRole("button", { name: "Publish v1" }));
    const link = await screen.findByRole("textbox", { name: "Public link" });
    rerender(<ArtifactShareDialog artifactId="artifact" versionId="v6" versionNumber={6} onClose={() => {}} />);
    expect(screen.getByRole("textbox", { name: "Public link" })).toBe(link);
    expect(link).toHaveValue(`${window.location.origin}/a/one-time`);
    expect(screen.getByText("Version v1")).toBeVisible();
  });

  it("requires a successful default change before removing it and preserves version identities when reordering", async () => {
    const artifact = versionedDetail(); let publication = artifact.publications[0]!;
    const mutations: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        const body = JSON.parse(init.body as string); mutations.push(body);
        if (publication.mode !== "version_set") throw new Error("fixture");
        publication = { ...publication, revision: publication.revision + 1,
          ...(body.action === "set_default" ? { defaultVersionId: body.versionId } : {}),
          ...(body.action === "remove" ? { versions: publication.versions.filter(version => version.id !== body.versionId) } : {}),
          ...(body.action === "add" ? { versions: [...publication.versions, ...body.versionIds.map((id: string) => artifact.versions.find(version => version.id === id)!)] } : {}),
          ...(body.action === "reorder" ? { versions: body.versionIds.map((id: string) => artifact.versions.find(version => version.id === id)!) } : {}) };
        return Response.json({ publication });
      }
      return Response.json({ artifact });
    }));
    render(<ArtifactShareDialog artifactId="artifact" versionId="v5" versionNumber={5} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Manage versions" }));
    const region = screen.getByRole("region", { name: "Published versions" });
    expect(within(region).getByRole("button", { name: "Remove v3" })).toBeDisabled();
    fireEvent.click(within(region).getByRole("button", { name: "Move v3 up" }));
    await waitFor(() => expect(within(region).getAllByRole("listitem").map(item => item.getAttribute("aria-label"))).toEqual(["v3", "v1", "v5"]));
    fireEvent.click(within(region).getByRole("button", { name: "Make v1 default" }));
    await waitFor(() => expect(within(region).getByRole("button", { name: "Remove v3" })).toBeEnabled());
    fireEvent.click(within(region).getByRole("button", { name: "Remove v3" }));
    await waitFor(() => expect(within(region).queryByRole("listitem", { name: "v3" })).not.toBeInTheDocument());
    fireEvent.change(within(region).getByRole("combobox", { name: "Add a version" }), { target: { value: "v6" } });
    fireEvent.click(within(region).getByRole("button", { name: "Add version" }));
    await within(region).findByRole("listitem", { name: "v6" });
    expect(mutations).toEqual([
      { expectedRevision: 1, action: "reorder", versionIds: ["v3", "v1", "v5"] },
      { expectedRevision: 2, action: "set_default", versionId: "v1" },
      { expectedRevision: 3, action: "remove", versionId: "v3" },
      { expectedRevision: 4, action: "add", versionIds: ["v6"] }
    ]);
    expect(artifact.versions).toHaveLength(4);
  });

  it("refreshes a conflicted publication without replaying the mutation", async () => {
    const artifact = versionedDetail(); const original = artifact.publications[0]!;
    const fresh = { ...original, revision: 2, defaultVersionId: "v1" };
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => init?.method === "PATCH"
      ? Response.json({ error: "artifact_publication_conflict" }, { status: 409 })
      : path.endsWith("/publications/set") ? Response.json({ publication: fresh }) : Response.json({ artifact }));
    vi.stubGlobal("fetch", fetcher);
    render(<ArtifactShareDialog artifactId="artifact" versionId="v5" versionNumber={5} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Manage versions" }));
    fireEvent.click(screen.getByRole("button", { name: "Make v5 default" }));
    await screen.findByText("This link changed elsewhere. Review its current versions before trying again.");
    expect(screen.getByRole("button", { name: "Remove v1" })).toBeDisabled();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  });

  it("makes reissue explicit after an ambiguous response, prevents duplicate rotations and never restores a lost URL", async () => {
    const artifact = versionedDetail(); let publication = artifact.publications[0]!;
    let fail!: (error: Error) => void; let rotations = 0;
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/reissue")) {
        rotations += 1;
        expect(JSON.parse(init!.body as string)).toEqual({ expectedRevision: rotations });
        publication = { ...publication, revision: rotations + 1 };
        if (rotations === 1) return new Promise<Response>((_resolve, reject) => { fail = reject; });
        return Response.json({ publication: { ...publication, publicPath: "/a/reissued-token" } });
      }
      return path.endsWith("/publications/set") ? Response.json({ publication }) : Response.json({ artifact });
    });
    vi.stubGlobal("fetch", fetcher);
    const { unmount } = render(<ArtifactShareDialog artifactId="artifact" versionId="v5" versionNumber={5} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reissue link" }));
    expect(screen.getByText("The old link will stop working. Published versions and the expiry date stay the same.")).toBeVisible();
    expect(screen.getByText(/fresh saved state/)).toBeVisible();
    const confirm = screen.getByRole("button", { name: "Reissue link" });
    fireEvent.click(confirm); fireEvent.click(confirm);
    expect(rotations).toBe(1);
    await act(async () => fail(new TypeError("Connection lost")));
    await screen.findByText("The new link could not be retrieved and cannot be recovered. Choose Reissue link again to create another link.");
    expect(rotations).toBe(1);
    expect(screen.queryByRole("textbox", { name: "Public link" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reissue link" }));
    expect(rotations).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Reissue link" }));
    expect(await screen.findByRole("textbox", { name: "Public link" })).toHaveValue(`${window.location.origin}/a/reissued-token`);
    expect(rotations).toBe(2);
    expect(localStorage.getItem("reissued-token")).toBeNull();
    unmount();
    render(<ArtifactShareDialog artifactId="artifact" versionId="v5" versionNumber={5} onClose={() => {}} />);
    await screen.findByRole("button", { name: "Reissue link" });
    expect(screen.queryByRole("textbox", { name: "Public link" })).not.toBeInTheDocument();
  });

  it("does not offer reissue for single, expired or revoked links", async () => {
    const artifact = versionedDetail(); const set = artifact.publications[0]!;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ artifact: { ...artifact, publications: [
      { ...set, id: "expired", expiresAt: "2020-01-01T00:00:00.000Z" }, { ...set, id: "revoked", status: "REVOKED" },
      { id: "single", versionId: "v1", status: "READY", createdAt: "2026-09-20T00:00:00.000Z", expiresAt: null }
    ] } })));
    render(<ArtifactShareDialog artifactId="artifact" versionId="v5" versionNumber={5} onClose={() => {}} />);
    await screen.findByText("Expired");
    expect(screen.queryByRole("button", { name: "Reissue link" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(1);
  });

  it("anchors a historical selection and loads bounded pages only on request while naming older single links", async () => {
    const all = versionedDetail();
    const artifact = { ...all, currentVersionId: "v6", versions: [all.versions[3]], versionsNextCursor: "v6",
      publications: [{ id: "old-single", versionId: "v101", versionNumber: 101, status: "READY", expiresAt: null, createdAt: "2026-09-20T00:00:00.000Z" }],
      publicationsNextCursor: "old-single" };
    const fetcher = vi.fn(async (path: string) => {
      if (path.endsWith("/versions?versionId=v1")) return Response.json({ versions: [all.versions[0]], nextCursor: null });
      if (path.endsWith("/versions?cursor=v6")) return Response.json({ versions: [all.versions[1], all.versions[0]], nextCursor: null });
      if (path.endsWith("/publications?cursor=old-single")) return Response.json({ publications: all.publications, nextCursor: null });
      return Response.json({ artifact });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ArtifactShareDialog artifactId="artifact" versionId="v1" versionNumber={1} onClose={() => {}} />);
    await screen.findByText("v101", { exact: true });
    expect(screen.getByRole("button", { name: "Publish v1" })).toBeEnabled();
    expect(fetcher).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("radio", { name: "Version set" }));
    expect(screen.getByRole("checkbox", { name: "Include v1" })).toBeChecked();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Load more versions" }));
    await screen.findByRole("checkbox", { name: "Include v3" });
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Load more versions" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more links" }));
    await screen.findByRole("button", { name: "Manage versions" });
    expect(screen.queryByRole("button", { name: "Load more links" })).not.toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
