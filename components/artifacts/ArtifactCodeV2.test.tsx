import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { highlightCodeBlock } from "@/components/chat/codeHighlighting";
import { ArtifactCodeV2, SourceCode } from "./ArtifactCodeV2";

vi.mock("@/components/chat/codeHighlighting", () => ({ highlightCodeBlock: vi.fn().mockResolvedValue(null) }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("artifact source groups", () => {
  it("keeps authored CDN references intact, groups vendor resources and skips highlighting large vendor text", async () => {
    const authored = '<script src="https://cdnjs.cloudflare.com/ajax/libs/example/1.0.0/example.min.js"></script>';
    const vendor = "漢".repeat(90_000);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ versionId: "version", files: [
      { path: "_vendor/1234567890123/example.js", mimeType: "text/javascript", text: vendor, group: "vendored", byteSize: 270_000 },
      { path: "index.html", mimeType: "text/html", text: authored, group: "authored", byteSize: authored.length },
      { path: "_vendor/abcdef0123456/font.woff2", mimeType: "font/woff2", binary: true, group: "vendored", byteSize: 42 }
    ] })));
    const copy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText: copy } });
    render(<ArtifactCodeV2 artifactId="artifact" versionId="version" />);
    await screen.findByRole("tab", { name: "index.html" });
    expect(screen.getAllByRole("tab")[0]).toHaveTextContent("index.html");
    expect(screen.getByText("Authored")).toBeVisible(); expect(screen.getByText("Vendored")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith(authored));
    const highlightedBefore = vi.mocked(highlightCodeBlock).mock.calls.length;
    fireEvent.keyDown(screen.getByRole("tab", { name: "index.html" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "_vendor/1234567890123/example.js" })).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveTextContent(vendor);
    expect(highlightCodeBlock).toHaveBeenCalledTimes(highlightedBefore);
    fireEvent.keyDown(screen.getByRole("tab", { name: "_vendor/1234567890123/example.js" }), { key: "End" });
    expect(screen.getByText("This resource is bundled with the artifact. Download the ZIP to save it.")).toBeVisible();
  });
  it("shows only the start of a long file with the way to the full file, and names binary files by their kind", async () => {
    const start = "<script>".repeat(32 * 1024);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ versionId: "version", files: [
      { path: "index.html", mimeType: "text/html", text: start, truncated: true, group: "authored", byteSize: 21_171_025 },
      { path: "report.pdf", mimeType: "application/pdf", binary: true, group: "authored", byteSize: 2048 },
      { path: "clip.mp4", mimeType: "video/mp4", binary: true, group: "authored", byteSize: 4096 },
      { path: "photo.png", mimeType: "image/png", binary: true, group: "authored", byteSize: 1024 }
    ] })));
    const { container } = render(<ArtifactCodeV2 artifactId="artifact/1" versionId="version" />);
    const note = await screen.findByRole("note");
    expect(note).toHaveTextContent("Showing the first 256 KB of 20.2 MB. Download the ZIP for the full file.");
    expect(screen.getByRole("link", { name: "Download the ZIP" })).toHaveAttribute("href", "/api/artifacts/artifact%2F1/versions/version/content?download=zip");
    // Copying the visible start would pass for the whole file.
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
    expect(container.querySelector("code")?.textContent).toBe(start);
    expect(highlightCodeBlock).not.toHaveBeenCalled();
    for (const [name, message] of [["report.pdf", "This file is part of the artifact."], ["clip.mp4", "This file is part of the artifact."], ["photo.png", "This image is part of the artifact."]]) {
      fireEvent.click(screen.getByRole("tab", { name }));
      expect(screen.getByRole("tabpanel")).toHaveTextContent(`${message} Download the ZIP to save the original.`);
    }
  });
  it("refuses a truncation mark on anything but text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ versionId: "version", files: [
      { path: "photo.png", mimeType: "image/png", binary: true, truncated: true, byteSize: 1 }
    ] })));
    render(<ArtifactCodeV2 artifactId="artifact" versionId="version" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The code could not be read.");
  });
  it("does not present malformed source metadata as a valid empty group", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ versionId: "version", files: [
      { path: "index.html", mimeType: "text/html", text: "body", group: "unknown", byteSize: -1 }
    ] })));
    render(<ArtifactCodeV2 artifactId="artifact" versionId="version" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The code could not be read.");
  });

  it("shows large source as one escaped block without highlighting or per-line DOM expansion", () => {
    const text = "<script>\n".repeat(50_000);
    const { container } = render(<SourceCode file={{ path: "large.html", mimeType: "text/plain", text }} />);
    expect(container.querySelector("code")?.textContent).toBe(text);
    expect(container.querySelectorAll("code > *, script")).toHaveLength(0);
    expect(highlightCodeBlock).not.toHaveBeenCalled();
  });

  it("does not show a late highlight result for a different source", async () => {
    let resolve!: (result: Awaited<ReturnType<typeof highlightCodeBlock>>) => void;
    vi.mocked(highlightCodeBlock).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const { rerender, container } = render(<SourceCode file={{ path: "one.js", mimeType: "text/plain", text: "oldSource" }} />);
    rerender(<SourceCode file={{ path: "two.js", mimeType: "text/plain", text: "newSource" }} />);
    await act(async () => { resolve({ html: "<pre>oldSource</pre>", language: "js" }); });
    expect(container).toHaveTextContent("newSource");
    expect(container).not.toHaveTextContent("oldSource");
  });
});
