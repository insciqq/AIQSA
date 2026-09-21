import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserLocksFixture } from "@/tests/support/browserLocks";
import type { ArtifactDetail } from "@/lib/contracts/artifacts";
import { ArtifactViewerV2 } from "./ArtifactViewerV2";

vi.mock("@/components/chat/codeHighlighting", () => ({ highlightCodeBlock: vi.fn().mockResolvedValue(null) }));

function detail(): ArtifactDetail {
  return { id: "artifact", title: "A small world", currentVersionId: "v2", sourceChatId: "chat", publications: [],
    versions: [{ id: "v1", title: "A small world", kind: "html", versionNumber: 1, entrypoint: "index.html", createdAt: "2026-09-18T12:00:00.000Z" },
      { id: "v2", title: "A small world", kind: "html", versionNumber: 2, entrypoint: "index.html", createdAt: "2026-09-20T12:00:00.000Z" }] };
}

function fetchArtifact(artifact = detail()) {
  return vi.fn(async (path: string) => {
    if (path.endsWith("/source")) return Response.json({ versionId: "v2", files: [{ path: "index.html", mimeType: "text/html", text: "<h1>Hello</h1>\n<p>World</p>" }, { path: "photo.png", mimeType: "image/png", binary: true }] });
    if (path.endsWith("/content")) return new Response("<h1>Hello</h1>", { headers: { "content-type": "text/html" } });
    return Response.json({ artifact });
  });
}

describe("ArtifactViewerV2", () => {
  beforeEach(() => vi.stubGlobal("navigator", { locks: createBrowserLocksFixture() }));
  afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("resets this artifact's saved state from its menu and clears the previous runtime error", async () => {
    vi.stubGlobal("fetch", fetchArtifact());
    render(<ArtifactViewerV2 artifactId="artifact" versionId="v2" host="page" onVersionChange={() => {}} onEditRequest={() => {}} />);
    const iframe = await screen.findByTitle("Artifact preview") as HTMLIFrameElement;
    act(() => window.dispatchEvent(new MessageEvent("message", { origin: "null", source: iframe.contentWindow,
      data: { type: "aiqsa_artifact_storage_set", key: "level", value: "3" } })));
    act(() => window.dispatchEvent(new MessageEvent("message", { origin: "null", source: iframe.contentWindow,
      data: { type: "aiqsa_artifact_runtime_error", kind: "error", message: "Bad saved state", line: 1, column: 0 } })));
    expect(screen.getByRole("alert")).toHaveTextContent("Bad saved state");
    fireEvent.click(screen.getByRole("button", { name: "Artifact actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Reset saved state" }));
    await screen.findByText("Saved state reset for this artifact.");
    expect(localStorage.getItem("aiqsa.artifact.state.artifact")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Saved state reset for this artifact.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTitle("Artifact preview")).not.toBe(iframe);
  });

  it("keeps preview sandboxed and exposes read-only code with exact copy and keyboard selection", async () => {
    vi.stubGlobal("fetch", fetchArtifact());
    const copy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { locks: navigator.locks, clipboard: { writeText: copy } });
    const onDetailChange = vi.fn();
    render(<ArtifactViewerV2 artifactId="artifact" versionId="v2" host="page" onVersionChange={() => {}} onEditRequest={() => {}} onDetailChange={onDetailChange} />);
    await screen.findByRole("heading", { name: "A small world" });
    const iframe = await screen.findByTitle("Artifact preview");
    expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-forms allow-pointer-lock allow-downloads");
    expect(iframe).toHaveAttribute("allow", "fullscreen; clipboard-write");
    expect(document.title).toBe("A small world · AIQSA");
    expect(onDetailChange).toHaveBeenCalledWith(detail());
    const preview = screen.getByRole("tab", { name: "Preview" });
    fireEvent.keyDown(preview, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Code" })).toHaveAttribute("aria-selected", "true");
    await screen.findByRole("tab", { name: "index.html" });
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await screen.findByRole("button", { name: "Copied" });
    expect(copy).toHaveBeenCalledWith("<h1>Hello</h1>\n<p>World</p>");
    fireEvent.keyDown(screen.getByRole("tab", { name: "index.html" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "photo.png" })).toHaveFocus();
    expect(screen.getByText("This image is part of the artifact. Download the ZIP to save the original.")).toBeVisible();
  });

  it("requires restoration for historical editing and selects versions in newest-first order", async () => {
    let artifact = detail();
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path.endsWith("/restore")) { artifact = { ...artifact, currentVersionId: "v1" }; return Response.json({ version: { id: "v1" } }); }
      return fetchArtifact(artifact)(path);
    }));
    function Harness() {
      const [version, setVersion] = useState("v1");
      return <ArtifactViewerV2 artifactId="artifact" versionId={version} host="library" onVersionChange={setVersion} onEditRequest={() => {}} />;
    }
    render(<Harness />);
    await screen.findByText("You’re viewing v1. The current version is v2.");
    expect(screen.getByRole("button", { name: "Edit with AI" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit with AI" })).toHaveAttribute("title", "Restore this version to edit it");
    fireEvent.click(screen.getByRole("button", { name: "Version v1" }));
    expect(screen.getAllByRole("menuitem").map(item => item.textContent)).toEqual(["v2 · current", "v1 · Sep 18"]);
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "v2 · current" }), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Restore v1" }));
    await screen.findByText("v1 is now the current version.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit with AI" })).toBeEnabled());
    expect(screen.queryByText("You’re viewing v1. The current version is v2.")).not.toBeInTheDocument();
  });

  it("keeps an open Share dialog and its one-time link when the selected chat version advances", async () => {
    vi.stubGlobal("navigator", { locks: navigator.locks, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    vi.stubGlobal("fetch", vi.fn(async (path: string) => path.endsWith("/publish")
      ? Response.json({ publication: { id: "single", versionId: "v1", status: "READY", expiresAt: null, createdAt: "2026-09-21T00:00:00.000Z", publicPath: "/a/captured-link" } })
      : fetchArtifact()(path)));
    const props = { artifactId: "artifact", host: "chat" as const, onClose: vi.fn(), onVersionChange: vi.fn(), onEditRequest: vi.fn() };
    const { rerender } = render(<ArtifactViewerV2 {...props} versionId="v1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Share" }));
    const dialog = await screen.findByRole("dialog", { name: "Share “A small world”" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Publish v1" }));
    const link = await within(dialog).findByRole("textbox", { name: "Public link" });
    rerender(<ArtifactViewerV2 {...props} versionId="v2" />);
    expect(screen.getByRole("dialog", { name: "Share “A small world”" })).toBe(dialog);
    expect(within(dialog).getByRole("textbox", { name: "Public link" })).toBe(link);
    expect(link).toHaveValue(`${window.location.origin}/a/captured-link`);
    expect(within(dialog).getByText("Version v1")).toBeVisible();
  });

  it("keeps a restored current version reachable outside the first history page", async () => {
    const all = detail(); const artifact = { ...all, currentVersionId: "v1", versions: [all.versions[1]!], versionsNextCursor: "v2" };
    const fetcher = vi.fn(async (path: string) => path.endsWith("/versions?versionId=v1")
      ? Response.json({ versions: [all.versions[0]], nextCursor: null })
      : fetchArtifact(artifact)(path));
    vi.stubGlobal("fetch", fetcher);
    const change = vi.fn();
    render(<ArtifactViewerV2 artifactId="artifact" versionId="v2" host="page" onVersionChange={change} onEditRequest={() => {}} />);
    await screen.findByText("You’re viewing v2. The current version is v1.");
    expect(screen.getByRole("button", { name: "Restore v2" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Back to current" }));
    expect(change).toHaveBeenCalledExactlyOnceWith("v1");
    expect(fetcher.mock.calls.filter(([path]) => path.includes("/versions?"))).toEqual([["/api/artifacts/artifact/versions?versionId=v1", expect.anything()]]);
  });

  it("accepts runtime errors only from its own opaque iframe and surfaces edit failures", async () => {
    vi.stubGlobal("fetch", fetchArtifact());
    const edit = vi.fn().mockRejectedValue(new Error("A newer version exists. Open the current version and try again."));
    render(<ArtifactViewerV2 artifactId="artifact" versionId="v2" host="chat" onVersionChange={() => {}} onEditRequest={edit} onClose={() => {}} />);
    await screen.findByRole("heading", { name: "A small world" });
    const iframe = await screen.findByTitle("Artifact preview") as HTMLIFrameElement;
    const error = { kind: "error", message: "counter is not defined", line: 32, column: 8 };
    const data = { type: "aiqsa_artifact_runtime_error", ...error };
    act(() => window.dispatchEvent(new MessageEvent("message", { data, origin: "https://example.com", source: iframe.contentWindow })));
    act(() => window.dispatchEvent(new MessageEvent("message", { data, origin: "null", source: window })));
    expect(screen.queryByRole("button", { name: "Fix with AI" })).not.toBeInTheDocument();
    act(() => window.dispatchEvent(new MessageEvent("message", { data: { ...data, message: "x".repeat(301) }, origin: "null", source: iframe.contentWindow })));
    expect(screen.queryByRole("button", { name: "Fix with AI" })).not.toBeInTheDocument();
    act(() => window.dispatchEvent(new MessageEvent("message", { data, origin: "null", source: iframe.contentWindow })));
    act(() => window.dispatchEvent(new MessageEvent("message", { data: { ...data, message: "Later error" }, origin: "null", source: iframe.contentWindow })));
    expect(screen.getByText("counter is not defined")).toBeVisible();
    expect(screen.queryByText("Later error")).not.toBeInTheDocument();
    expect(screen.getByText("(line 32, approximate)")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Fix with AI" }));
    await screen.findByText("A newer version exists. Open the current version and try again.");
    expect(edit).toHaveBeenCalledWith("runtime_error", error);
  });
  it("shows a bounded CSP origin as text and forwards only validated details", async () => {
    vi.stubGlobal("fetch", fetchArtifact());
    const edit = vi.fn();
    render(<ArtifactViewerV2 artifactId="artifact" versionId="v2" host="page" onVersionChange={() => {}} onEditRequest={edit} />);
    const iframe = await screen.findByTitle("Artifact preview") as HTMLIFrameElement;
    const error = { kind: "csp", message: "Blocked resource", line: 0, column: 0, directive: "connect-src", blocked: "https://example.com" };
    act(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "aiqsa_artifact_runtime_error", ...error, ignored: "secret" }, origin: "null", source: iframe.contentWindow })));
    expect(screen.getByRole("alert")).toHaveTextContent("blocked resource: connect-src · https://example.com");
    fireEvent.click(screen.getByRole("button", { name: "Fix with AI" }));
    expect(edit).toHaveBeenCalledWith("runtime_error", error);
  });

  it("expands as a modal and restores the expansion control after Escape", async () => {
    vi.stubGlobal("fetch", fetchArtifact());
    render(<ArtifactViewerV2 artifactId="artifact" versionId="v2" host="library" onVersionChange={() => {}} onEditRequest={() => {}} updatedVersionNumber={2} />);
    await screen.findByRole("heading", { name: "A small world" });
    const iframe = await screen.findByTitle("Artifact preview") as HTMLIFrameElement;
    const browsingContext = iframe.contentWindow;
    expect(screen.getByText("Updated to v2")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Expand artifact" }));
    const dialog = await screen.findByRole("dialog", { name: "Artifact: A small world" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.queryByText("Updated to v2")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse artifact" })).toHaveFocus();
    expect(screen.getByTitle("Artifact preview")).toBe(iframe);
    expect(iframe.contentWindow).toBe(browsingContext);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Expand artifact" })).toHaveFocus());
    expect(document.body.style.overflow).toBe("");
    expect(screen.getByTitle("Artifact preview")).toBe(iframe);
  });

  it("preserves the selected source file and iframe across expand and compact transitions", async () => {
    vi.stubGlobal("fetch", fetchArtifact());
    const props = { artifactId: "artifact", versionId: "v2", host: "chat" as const,
      onVersionChange: vi.fn(), onEditRequest: vi.fn(), onClose: vi.fn() };
    const { rerender } = render(<ArtifactViewerV2 {...props} compact={false} />);
    const iframe = await screen.findByTitle("Artifact preview") as HTMLIFrameElement;
    const browsingContext = iframe.contentWindow;
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    fireEvent.click(await screen.findByRole("tab", { name: "photo.png" }));
    const fileTab = screen.getByRole("tab", { name: "photo.png" });
    const assertSelection = () => {
      expect(screen.getByRole("tab", { name: "Code" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("tab", { name: "photo.png" })).toBe(fileTab);
      expect(fileTab).toHaveAttribute("aria-selected", "true");
      expect(screen.getByTitle("Artifact preview")).toBe(iframe);
      expect(iframe.contentWindow).toBe(browsingContext);
    };
    fireEvent.click(screen.getByRole("button", { name: "Expand artifact" }));
    assertSelection();
    fireEvent.click(screen.getByRole("button", { name: "Collapse artifact" }));
    assertSelection();
    rerender(<ArtifactViewerV2 {...props} compact />);
    expect(screen.getByRole("dialog", { name: "Artifact: A small world" })).toHaveAttribute("aria-modal", "true");
    assertSelection();
    rerender(<ArtifactViewerV2 {...props} compact={false} />);
    expect(screen.getByRole("complementary", { name: "Artifact: A small world" })).not.toHaveAttribute("aria-modal");
    assertSelection();
  });

  it("opens the Library source chat through its state-preserving callback and reports unavailable chats", async () => {
    vi.stubGlobal("fetch", fetchArtifact());
    const onOpenSourceChat = vi.fn().mockRejectedValue(new Error("This chat is no longer available."));
    render(<ArtifactViewerV2 artifactId="artifact" versionId="v2" host="library" onVersionChange={() => {}}
      onEditRequest={() => {}} onOpenSourceChat={onOpenSourceChat} />);
    await screen.findByRole("heading", { name: "A small world" });
    fireEvent.click(screen.getByRole("button", { name: "Artifact actions" }));
    const openChat = screen.getByRole("menuitem", { name: "Open source chat" });
    expect(openChat.tagName).toBe("BUTTON");
    expect(openChat).not.toHaveAttribute("href");
    fireEvent.click(openChat);
    await screen.findByText("This chat is no longer available.");
    expect(onOpenSourceChat).toHaveBeenCalledExactlyOnceWith("chat");
  });

  it("closes on iframe Escape only while that exact opaque iframe owns focus", async () => {
    vi.stubGlobal("fetch", fetchArtifact());
    const onClose = vi.fn();
    render(<ArtifactViewerV2 artifactId="artifact" versionId="v2" host="chat" onVersionChange={() => {}} onEditRequest={() => {}} onClose={onClose} />);
    const iframe = await screen.findByTitle("Artifact preview") as HTMLIFrameElement;
    const data = { type: "aiqsa_artifact_escape" };
    act(() => window.dispatchEvent(new MessageEvent("message", { data, origin: "null", source: iframe.contentWindow })));
    expect(onClose).not.toHaveBeenCalled();
    iframe.focus();
    act(() => window.dispatchEvent(new MessageEvent("message", { data, origin: "https://example.com", source: iframe.contentWindow })));
    act(() => window.dispatchEvent(new MessageEvent("message", { data, origin: "null", source: window })));
    expect(onClose).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new MessageEvent("message", { data, origin: "null", source: iframe.contentWindow })));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps a failed detail response distinct from empty history and retries", async () => {
    const fetcher = fetchArtifact();
    let failed = false;
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path === "/api/artifacts/artifact" && !failed) { failed = true; return new Response("{}", { status: 404 }); }
      return fetcher(path);
    }));
    render(<ArtifactViewerV2 artifactId="artifact" versionId="v2" host="page" onVersionChange={() => {}} onEditRequest={() => {}} />);
    await screen.findByText("This artifact is no longer available.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("heading", { name: "A small world" });
    expect(await screen.findByTitle("Artifact preview")).toBeInTheDocument();
  });
});
