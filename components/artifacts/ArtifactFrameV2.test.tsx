import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserLocksFixture } from "@/tests/support/browserLocks";
import { ARTIFACT_BRIDGE_SCRIPT_OPEN, ARTIFACT_STORAGE_PLACEHOLDER } from "@/lib/contracts/artifactRuntime";
import { ArtifactFrameV2 } from "./ArtifactFrameV2";
import { artifactBrowserStorage, privateArtifactStateKey, publicArtifactStateKey } from "./artifactBrowserStorage";

const body = `${ARTIFACT_BRIDGE_SCRIPT_OPEN}const initial=${ARTIFACT_STORAGE_PLACEHOLDER};</script><h1>Small world</h1>`;
const link = { type: "aiqsa_artifact_open_link", href: "https://example.com/guide" };
function message(iframe: HTMLIFrameElement, data: unknown, origin = "null", source = iframe.contentWindow) {
  act(() => window.dispatchEvent(new MessageEvent("message", { data, origin, source })));
}
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
beforeEach(() => vi.stubGlobal("navigator", { locks: createBrowserLocksFixture() }));

describe("artifact frame host", () => {
  it("ignores forged messages and allows only one confirmation at a time, with a 500 ms limit", async () => {
    let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<ArtifactFrameV2 body={body} artifactId="links" title="Preview" />);
    const iframe = await screen.findByTitle("Preview") as HTMLIFrameElement;
    message(iframe, link, "https://example.com");
    message(iframe, link, "null", window);
    message(iframe, { ...link, href: "javascript:alert(1)" });
    message(iframe, { ...link, trusted: true });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    iframe.focus(); message(iframe, link);
    const dialog = await screen.findByRole("dialog", { name: "Open external link?" });
    expect(within(dialog).getByLabelText("Full link address")).toHaveTextContent(link.href);
    expect(within(dialog).getByText("example.com", { exact: true }).tagName).toBe("STRONG");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    now = 1000; message(iframe, { ...link, href: "https://other.example/" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(within(dialog).getByLabelText("Full link address")).toHaveTextContent(link.href);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(open).not.toHaveBeenCalled();
    await waitFor(() => expect(iframe).toHaveFocus());
    now = 100; message(iframe, link);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    now = 501; message(iframe, link);
    fireEvent.click(screen.getByRole("button", { name: "Open link" }));
    expect(open).toHaveBeenCalledExactlyOnceWith(link.href, "_blank", "noopener,noreferrer");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    now = 1002; message(iframe, link);
    expect(screen.getByRole("dialog")).toBeVisible();
  });
  it("warns about encoded addresses, copies exactly and offers manual recovery without opening", async () => {
    const copy = vi.fn().mockRejectedValueOnce(new Error("denied")).mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { locks: navigator.locks, clipboard: { writeText: copy } });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<ArtifactFrameV2 body={body} artifactId="copy" title="Preview" />);
    const iframe = await screen.findByTitle("Preview") as HTMLIFrameElement;
    const href = `https://example.com/?data=${"a".repeat(90)}`;
    message(iframe, { ...link, href });
    expect(screen.getByText("This link carries additional data in its address.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    await screen.findByText("Select the address and copy it manually.");
    fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    await screen.findByRole("button", { name: "Copied" });
    expect(copy).toHaveBeenLastCalledWith(href);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(open).not.toHaveBeenCalled();
  });
  it("persists only validated local state without reloading the running iframe, and initializes the next opening", async () => {
    const first = render(<ArtifactFrameV2 body={body} artifactId="saved" title="Preview" />);
    const iframe = await screen.findByTitle("Preview") as HTMLIFrameElement;
    const originalDocument = iframe.srcdoc;
    message(iframe, { type: "aiqsa_artifact_storage_set", key: "score", value: "42" }, "null", window);
    expect(localStorage.getItem(privateArtifactStateKey("saved"))).toBeNull();
    message(iframe, { type: "aiqsa_artifact_storage_set", key: "score", value: "42" });
    await waitFor(() => expect(localStorage.getItem(privateArtifactStateKey("saved"))).toContain('"score","42"'));
    expect(screen.getByTitle("Preview")).toBe(iframe); expect(iframe.srcdoc).toBe(originalDocument);
    message(iframe, { type: "aiqsa_artifact_storage_set", key: "other", value: "not admitted", namespace: "other" });
    expect(localStorage.getItem(privateArtifactStateKey("saved"))).not.toContain("other");
    first.unmount();
    render(<ArtifactFrameV2 body={`${body}<p>Version 2</p>`} artifactId="saved" title="Preview" />);
    expect(await screen.findByTitle("Preview")).toHaveAttribute("srcdoc", expect.stringContaining('[["score","42"]]'));
  });
  it("shows storage failure without interrupting the preview, and an explicit reset starts an empty document", async () => {
    const resetKey = privateArtifactStateKey("reset");
    render(<ArtifactFrameV2 body={body} artifactId="reset" title="Preview" />);
    const iframe = await screen.findByTitle("Preview") as HTMLIFrameElement;
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Denied", "QuotaExceededError"); });
    message(iframe, { type: "aiqsa_artifact_storage_set", key: "score", value: "42" });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved state is unavailable in this browser"));
    expect(screen.getByTitle("Preview")).toBe(iframe);
    write.mockRestore();
    await act(async () => { await artifactBrowserStorage.clear(resetKey); });
    expect(screen.getByTitle("Preview")).not.toBe(iframe);
    expect(screen.getByTitle("Preview")).toHaveAttribute("srcdoc", expect.stringContaining("const initial=[]"));
    expect(screen.queryByText(/Saved state is unavailable/)).not.toBeInTheDocument();
  });
  it("uses the same link protection on public frames and does not surface private runtime repair", async () => {
    vi.stubGlobal("crypto", { randomUUID: crypto.randomUUID.bind(crypto), subtle: { digest: vi.fn().mockResolvedValue(new Uint8Array(32).fill(3).buffer) } });
    const publicKey = await publicArtifactStateKey("publication-token");
    render(<ArtifactFrameV2 body={body} publicToken="publication-token" title="Public" />);
    const iframe = await screen.findByTitle("Public") as HTMLIFrameElement;
    message(iframe, { type: "aiqsa_artifact_storage_set", key: "level", value: "5" });
    await waitFor(() => expect(localStorage.getItem(publicKey)).toContain('"level","5"'));
    expect(localStorage.getItem(publicKey)).not.toContain("publication-token");
    message(iframe, { type: "aiqsa_artifact_runtime_error", kind: "error", message: "private detail", line: 1, column: 0 });
    expect(screen.queryByText("private detail")).not.toBeInTheDocument();
    message(iframe, link);
    expect(screen.getByRole("dialog", { name: "Open external link?" })).toBeVisible();
  });
});
