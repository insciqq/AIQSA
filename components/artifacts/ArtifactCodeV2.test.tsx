import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { highlightCodeBlock } from "@/components/chat/codeHighlighting";
import { ArtifactCodeV2 } from "./ArtifactCodeV2";

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
  it("does not present malformed source metadata as a valid empty group", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ versionId: "version", files: [
      { path: "index.html", mimeType: "text/html", text: "body", group: "unknown", byteSize: -1 }
    ] })));
    render(<ArtifactCodeV2 artifactId="artifact" versionId="version" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The code could not be read.");
  });
});
