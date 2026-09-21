import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactThumbnailV2 } from "./ArtifactThumbnailV2";

function observe() {
  const callbacks: IntersectionObserverCallback[] = [];
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { callbacks.push(callback); }
    observe() {}
    disconnect() {}
  });
  return (visible = true) => act(() => callbacks.forEach(callback => callback([{ isIntersecting: visible }] as IntersectionObserverEntry[], {} as IntersectionObserver)));
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("inert artifact thumbnails", () => {
  it("requests only visible eligible artifacts and destroys offscreen preview content", async () => {
    const visible = observe();
    const fetch = vi.fn().mockResolvedValue(new Response("<h1>Thumbnail</h1>", { headers: { "content-type": "text/html" } }));
    vi.stubGlobal("fetch", fetch);
    render(<><ArtifactThumbnailV2 artifactId="a" versionId="v" kind="html" byteSize={20} />
      <ArtifactThumbnailV2 artifactId="game" versionId="v" kind="game" byteSize={20} />
      <ArtifactThumbnailV2 artifactId="large" versionId="v" kind="html" byteSize={2 * 1024 * 1024} /></>);
    expect(fetch).not.toHaveBeenCalled();
    visible();
    const iframe = await screen.findByTitle("Artifact thumbnail");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(iframe).toHaveAttribute("sandbox", "");
    expect(iframe).toHaveAttribute("inert");
    expect(iframe).toHaveAttribute("tabindex", "-1");
    expect(iframe).toHaveAttribute("aria-hidden", "true");
    visible(false);
    expect(screen.queryByTitle("Artifact thumbnail")).not.toBeInTheDocument();
  });
  it("limits concurrent requests to six and starts the next only when a slot is released", async () => {
    const visible = observe();
    const resolve: Array<(response: Response) => void> = [];
    const fetch = vi.fn((_path: string, init: RequestInit) => new Promise<Response>((done, reject) => {
      resolve.push(done);
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetch);
    const { unmount } = render(<>{Array.from({ length: 8 }, (_, index) => <ArtifactThumbnailV2 key={index} artifactId={`a${index}`} versionId="v" kind="html" byteSize={20} />)}</>);
    visible();
    expect(fetch).toHaveBeenCalledTimes(6);
    await act(async () => resolve[0](new Response("<p>One</p>", { headers: { "content-type": "text/html" } })));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(7));
    unmount();
    await act(async () => { await Promise.resolve(); });
  });
  it("falls back to the icon after five seconds and aborts the fetch", async () => {
    vi.useFakeTimers();
    const visible = observe();
    let signal: AbortSignal | null = null;
    vi.stubGlobal("fetch", vi.fn((_path: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init.signal as AbortSignal;
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })));
    render(<ArtifactThumbnailV2 artifactId="a" versionId="v" kind="html" byteSize={20} />);
    visible();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    expect(screen.queryByTitle("Artifact thumbnail")).not.toBeInTheDocument();
  });
});
