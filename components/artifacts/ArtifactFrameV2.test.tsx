import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserLocksFixture } from "@/tests/support/browserLocks";
import { ARTIFACT_BRIDGE_SCRIPT_OPEN, ARTIFACT_STORAGE_PLACEHOLDER } from "@/lib/contracts/artifactRuntime";
import { ArtifactFrameV2 } from "./ArtifactFrameV2";
import { artifactBrowserStorage, privateArtifactStateKey, publicArtifactStateKey } from "./artifactBrowserStorage";
import { ARTIFACT_DOWNLOAD_LIMITS, artifactDownloadTurns } from "./artifactDownload";

const body = `${ARTIFACT_BRIDGE_SCRIPT_OPEN}const initial=${ARTIFACT_STORAGE_PLACEHOLDER};</script><h1>Small world</h1>`;
const link = { type: "aiqsa_artifact_open_link", href: "https://example.com/guide" };
function message(iframe: HTMLIFrameElement, data: unknown, origin = "null", source = iframe.contentWindow) {
  act(() => window.dispatchEvent(new MessageEvent("message", { data, origin, source })));
}
afterEach(() => { vi.useRealTimers(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); artifactDownloadTurns.reset(); });

/** Saves go through an anchor click on an object URL; jsdom has neither download nor object URLs. */
function captureSaves() {
  const blobs: Blob[] = [];
  vi.stubGlobal("URL", Object.assign(class extends URL {}, {
    createObjectURL: (blob: Blob) => { blobs.push(blob); return `blob:https://app.example/${blobs.length}`; }, revokeObjectURL: vi.fn() }));
  const saves: Array<{ name: string; type: string; href: string }> = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    saves.push({ name: this.download, type: blobs.at(-1)?.type ?? "", href: this.getAttribute("href") ?? "" });
  });
  return saves;
}
const download = (name: string, blob: Blob = new Blob(["a,b\n"], { type: "text/html" })) => ({ type: "aiqsa_artifact_download", name, blob });
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
  it("forwards only validated page navigation from its own frame, keeps the latest request inside the 500 ms interval and never acts under a link confirmation", async () => {
    let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
    const onNavigate = vi.fn();
    render(<ArtifactFrameV2 body={body} artifactId="pages" title="Preview" onNavigate={onNavigate} />);
    const iframe = await screen.findByTitle("Preview") as HTMLIFrameElement;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const navigate = { type: "aiqsa_artifact_navigate", path: "docs/about.html", fragment: "team" };
    message(iframe, navigate, "https://example.com");
    message(iframe, navigate, "null", window);
    for (const forged of [{ ...navigate, path: "../private.html" }, { ...navigate, path: "_vendor/0123456789ab/page.html" }, { ...navigate, trusted: true },
      { ...navigate, fragment: "" }, { ...navigate, fragment: "x".repeat(257) }, [navigate]]) message(iframe, forged);
    act(() => vi.advanceTimersByTime(1000));
    expect(onNavigate).not.toHaveBeenCalled();
    now = 1000; message(iframe, navigate);
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith({ path: "docs/about.html", fragment: "team" }, false);
    // Two quick clicks: the second page opens once the interval has passed.
    now = 1100; message(iframe, { type: "aiqsa_artifact_navigate", path: "index.html" });
    expect(onNavigate).toHaveBeenCalledOnce();
    now = 1499; act(() => vi.advanceTimersByTime(399));
    expect(onNavigate).toHaveBeenCalledOnce();
    now = 1500; act(() => vi.advanceTimersByTime(1));
    expect(onNavigate).toHaveBeenCalledTimes(2);
    expect(onNavigate).toHaveBeenLastCalledWith({ path: "index.html" }, false);
    // Three quick clicks: the first opens at once, only the last of the others follows.
    now = 3000; message(iframe, { type: "aiqsa_artifact_navigate", path: "one.html" });
    now = 3100; message(iframe, { type: "aiqsa_artifact_navigate", path: "two.html" });
    now = 3200; message(iframe, { type: "aiqsa_artifact_navigate", path: "three.html" });
    now = 3500; act(() => vi.advanceTimersByTime(500));
    expect(onNavigate.mock.calls.slice(2).map(([target]) => target.path)).toEqual(["one.html", "three.html"]);
    // A link confirmation replaces a waiting page request, and requests during it are ignored.
    now = 4000; message(iframe, { type: "aiqsa_artifact_navigate", path: "four.html" });
    now = 4100; message(iframe, { type: "aiqsa_artifact_navigate", path: "five.html" });
    message(iframe, link);
    const dialog = screen.getByRole("dialog", { name: "Open external link?" });
    now = 5000; message(iframe, { type: "aiqsa_artifact_navigate", path: "guide.html" });
    act(() => vi.advanceTimersByTime(2000));
    expect(onNavigate).toHaveBeenCalledTimes(5);
    expect(onNavigate).toHaveBeenLastCalledWith({ path: "four.html" }, false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    act(() => iframe.focus());
    now = 6000; message(iframe, { type: "aiqsa_artifact_navigate", path: "guide.html" });
    expect(onNavigate).toHaveBeenLastCalledWith({ path: "guide.html" }, true);
  });
  it("keeps a request refused while another page loads until the next document, and forgets it when the viewer closes", async () => {
    let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
    const onNavigate = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const { rerender, unmount } = render(<ArtifactFrameV2 body={body} artifactId="busy" title="Preview" revision={1} onNavigate={onNavigate} />);
    const iframe = await screen.findByTitle("Preview") as HTMLIFrameElement;
    message(iframe, { type: "aiqsa_artifact_navigate", path: "guide.html" });
    expect(onNavigate).toHaveBeenCalledOnce();
    now = 2000;
    rerender(<ArtifactFrameV2 body={body} artifactId="busy" title="Preview" revision={2} onNavigate={onNavigate} />);
    await waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(2));
    expect(onNavigate).toHaveBeenLastCalledWith({ path: "guide.html" }, false);
    const second = await screen.findByTitle("Preview") as HTMLIFrameElement;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    now = 2100; message(second, { type: "aiqsa_artifact_navigate", path: "late.html" });
    unmount();
    now = 9000; act(() => vi.advanceTimersByTime(1000));
    expect(onNavigate).toHaveBeenCalledTimes(2);
  });
  it("loads a new document for a new revision of the same page and moves focus into it only when asked", async () => {
    const onNavigate = vi.fn();
    const { rerender } = render(<ArtifactFrameV2 body={body} artifactId="revision" title="Preview" revision={1} onNavigate={onNavigate} />);
    const first = await screen.findByTitle("Preview") as HTMLIFrameElement;
    expect(first).not.toHaveFocus();
    const stale = first.contentWindow;
    rerender(<ArtifactFrameV2 body={body} artifactId="revision" title="Preview" revision={2} focusOnLoad onNavigate={onNavigate} />);
    await waitFor(() => expect(screen.getByTitle("Preview")).not.toBe(first));
    const second = screen.getByTitle("Preview") as HTMLIFrameElement;
    await waitFor(() => expect(second).toHaveFocus());
    // The replaced document cannot speak for the new one.
    act(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "aiqsa_artifact_navigate", path: "a.html" }, origin: "null", source: stale })));
    expect(onNavigate).not.toHaveBeenCalled();
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

  it("saves a frame's download only from its own frame, during user activation and within the burst, as a cleaned octet-stream copy", async () => {
    let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
    let active = true;
    vi.stubGlobal("navigator", { locks: navigator.locks, get userActivation() { return { isActive: active }; } });
    const saves = captureSaves();
    render(<ArtifactFrameV2 body={body} artifactId="downloads" title="Preview" />);
    const iframe = await screen.findByTitle("Preview") as HTMLIFrameElement;
    // Forged: another origin, another window, extra fields, a name past the bound, bytes that are no Blob.
    message(iframe, download("forged.csv"), "https://example.com");
    message(iframe, download("forged.csv"), "null", window);
    for (const forged of [{ ...download("forged.csv"), trusted: true }, download("x".repeat(ARTIFACT_DOWNLOAD_LIMITS.maxRequestedNameCharacters + 1)),
      { ...download("forged.csv"), blob: new Uint8Array([1, 2]) }, { ...download("forged.csv"), blob: "a,b" }]) message(iframe, forged);
    expect(saves).toEqual([]);
    expect(screen.queryByTestId("artifact-download-prompt")).not.toBeInTheDocument();
    // Activation from elsewhere in the app, while focus is outside the frame, only asks.
    message(iframe, download("unfocused.csv"));
    expect(saves).toEqual([]);
    fireEvent.click(within(screen.getByTestId("artifact-download-prompt")).getByRole("button", { name: "Dismiss" }));
    now = 1_000;
    act(() => iframe.focus());
    message(iframe, download("..\\..\\inv‮oice​.html"));
    expect(saves).toEqual([{ name: "_.._invoice.html", type: "application/octet-stream", href: "blob:https://app.example/1" }]);
    // A flood after one click: the burst saves, the rest waits for one confirmation at a time.
    for (let index = 0; index < 10; index++) message(iframe, download(`flood-${index}.txt`));
    expect(saves.map(save => save.name)).toEqual(["_.._invoice.html", "flood-0.txt", "flood-1.txt"]);
    const prompt = screen.getByTestId("artifact-download-prompt");
    expect(prompt).toHaveTextContent("Save “flood-2.txt” (4 bytes) from this artifact?");
    fireEvent.click(within(prompt).getByRole("button", { name: "Save file" }));
    expect(saves.map(save => save.name).at(-1)).toBe("flood-2.txt");
    expect(screen.queryByTestId("artifact-download-prompt")).not.toBeInTheDocument();
    expect(saves).toHaveLength(4);
    // Without user activation nothing saves by itself; a dismissed request is gone.
    active = false; now = 20_000;
    message(iframe, download("later.csv"));
    expect(saves).toHaveLength(4);
    fireEvent.click(within(screen.getByTestId("artifact-download-prompt")).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("artifact-download-prompt")).not.toBeInTheDocument();
    expect(saves).toHaveLength(4);
    // A request soon after a prompt waits out the interval; a file over the limit is refused with its reason.
    now = 20_100; message(iframe, download("soon.csv"));
    expect(screen.queryByTestId("artifact-download-prompt")).not.toBeInTheDocument();
    const huge = new Blob(["x"]);
    Object.defineProperty(huge, "size", { value: ARTIFACT_DOWNLOAD_LIMITS.maxBytes + 1 });
    active = true; now = 21_000;
    message(iframe, download("huge.bin", huge));
    expect(screen.getByTestId("artifact-download-prompt")).toHaveTextContent("“huge.bin” is too large to save from the preview. Files up to 64 MB can be saved.");
    expect(within(screen.getByTestId("artifact-download-prompt")).queryByRole("button", { name: "Save file" })).not.toBeInTheDocument();
    expect(saves).toHaveLength(4);
  });

  it("asks before saving where the browser cannot report user activation, and forgets the question with its document", async () => {
    vi.stubGlobal("navigator", { locks: navigator.locks });
    const saves = captureSaves();
    const { rerender } = render(<ArtifactFrameV2 body={body} artifactId="old-browser" title="Preview" />);
    const iframe = await screen.findByTitle("Preview") as HTMLIFrameElement;
    message(iframe, download("report.csv"));
    expect(saves).toEqual([]);
    expect(screen.getByTestId("artifact-download-prompt")).toHaveTextContent("Save “report.csv” (4 bytes) from this artifact?");
    rerender(<ArtifactFrameV2 body={`${body}<p>Next page</p>`} artifactId="old-browser" title="Preview" />);
    await waitFor(() => expect(screen.getByTitle("Preview")).not.toBe(iframe));
    expect(screen.queryByTestId("artifact-download-prompt")).not.toBeInTheDocument();
    expect(saves).toEqual([]);
  });
});
