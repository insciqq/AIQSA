import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { FilesPanelV2 } from "./LibraryV2";
import type { FileSummaryV2 } from "./contracts";

vi.mock("@/components/chat/MarkdownMessage", async importOriginal => {
  const original = await importOriginal<typeof import("@/components/chat/MarkdownMessage")>();
  return { ...original, MarkdownMessage: (props: ComponentProps<typeof original.MarkdownMessage>) => {
    if (props.content === "synthetic-render-failure") throw new Error("synthetic-render-failure");
    return <original.MarkdownMessage {...props} />;
  } };
});

const file = (id: string, name: string, extra: Partial<FileSummaryV2> = {}): FileSummaryV2 => ({
  id, name, byteSize: 100, canOpenChat: true, chatId: "chat", chatTitle: "Synthetic chat",
  createdAt: "2026-09-22T00:00:00.000Z", savedAt: null, previewKind: "text", status: "ready", ...extra
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Files preview", () => {
  it("offers only eligible ready previews and replaces a failed lazy thumbnail with its type tile", () => {
    const { container } = render(<FilesPanelV2 files={[
      file("png", "photo.png", { previewKind: "image" }), file("pdf", "notes.pdf", { previewKind: null }),
      file("pending", "pending.png", { previewKind: null, status: "processing" }),
      file("large", "large.txt", { previewKind: null }), file("md", "readme.md")
    ]} />);
    expect(screen.getAllByRole("button", { name: /^View / })).toHaveLength(2);
    const image = container.querySelector("img")!;
    expect(image).toHaveAttribute("loading", "lazy");
    expect(image).toHaveAttribute("src", "/api/attachments/png/content?preview=thumb");
    fireEvent.error(image);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getAllByText("PNG")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Download notes.pdf" })).toHaveAttribute("download");
  });

  it("keeps source inert, navigates within its group, fences a late response and restores the selected row", async () => {
    let resolveFirst!: (response: Response) => void;
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal);
      return url.includes("/first/") ? new Promise<Response>(resolve => { resolveFirst = resolve; })
        : Promise.resolve(new Response('<iframe src="https://external.test"></iframe><script>globalThis.executed = true</script>'));
    }));
    render(<FilesPanelV2 files={[file("first", "first.txt"), file("second", "second.html"),
      file("unsupported", "notes.pdf", { previewKind: null }),
      file("saved", "saved.md", { savedAt: "2026-09-22T00:00:00.000Z", chatId: null, chatTitle: null, canOpenChat: false })]} />);
    fireEvent.click(screen.getByRole("button", { name: "View first.txt" }));
    const first = await screen.findByRole("dialog", { name: "File preview: first.txt" });
    await waitFor(() => expect(within(first).getByRole("button", { name: "Close preview" })).toHaveFocus());
    expect(within(first).getByText("1 of 2 in this chat")).toBeVisible();
    expect(within(first).getByRole("button", { name: "Previous file" })).toBeDisabled();
    fireEvent.click(within(first).getByRole("button", { name: "Next file" }));
    const second = await screen.findByRole("dialog", { name: "File preview: second.html" });
    await waitFor(() => expect(second.querySelector("code")).toHaveTextContent("globalThis.executed"));
    expect(signals[0].aborted).toBe(true);
    expect(second.querySelectorAll("iframe, object, embed, script, img, a[href^='https:']")).toHaveLength(0);
    expect(within(second).queryByRole("radio")).toBeNull();
    expect(within(second).getByText("2 of 2 in this chat")).toBeVisible();
    await act(async () => { resolveFirst(new Response("late response for first")); });
    expect(second).not.toHaveTextContent("late response for first");
    fireEvent.keyDown(second, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(signals[1].aborted).toBe(true);
    await waitFor(() => expect(screen.getByRole("button", { name: "View second.html" })).toHaveFocus());
  });

  it("renders bounded Markdown without external links or image loads and keeps the exact source", async () => {
    const source = '# Summary\n\n[External](https://external.test)\n\n![Hidden](https://external.test/image.png)\n\n' + '> '.repeat(3000) + 'deep';
    const fetchMock = vi.fn().mockResolvedValue(new Response(source));
    vi.stubGlobal("fetch", fetchMock);
    render(<FilesPanelV2 files={[file("markdown", "readme.md")]} />);
    fireEvent.click(screen.getByRole("button", { name: "View readme.md" }));
    const preview = await screen.findByRole("dialog");
    await within(preview).findByRole("heading", { name: "Summary" });
    expect(preview.querySelectorAll("img, iframe, object, embed, a[href^='https:']")).toHaveLength(0);
    fireEvent.click(within(preview).getByRole("radio", { name: "Source" }));
    await waitFor(() => expect(preview.querySelector("code")?.textContent).toBe(source));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to Source after a renderer error while keeping Files and its actions usable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("synthetic-render-failure")));
    const onUse = vi.fn();
    render(<FilesPanelV2 files={[file("markdown", "broken.md")]} onUse={onUse} />);
    fireEvent.click(screen.getByRole("button", { name: "View broken.md" }));
    const preview = await screen.findByRole("dialog");
    expect(await within(preview).findByText("Rendered view is unavailable for this file.")).toBeVisible();
    expect(within(preview).getByRole("radio", { name: "Source" })).toHaveAttribute("aria-checked", "true");
    expect(preview.querySelector("code")?.textContent).toBe("synthetic-render-failure");
    fireEvent.click(within(preview).getByRole("button", { name: "Use in chat" }));
    expect(onUse).toHaveBeenCalledWith("markdown");
  });

  it("offers Download on failure and closes when the file leaves its visible group", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 415 })));
    const source = file("missing", "missing.txt");
    const { rerender } = render(<FilesPanelV2 files={[source]} />);
    fireEvent.click(screen.getByRole("button", { name: "View missing.txt" }));
    const preview = await screen.findByRole("dialog");
    expect(await within(preview).findByText("Preview is unavailable. Download the file instead.")).toBeVisible();
    expect(within(preview).getByRole("link", { name: "Download" })).toHaveAttribute("href", "/api/attachments/missing/content");
    rerender(<FilesPanelV2 files={[{ ...source, savedAt: "2026-09-22T00:00:00.000Z", chatId: null, chatTitle: null }]} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "View missing.txt" })).toBeVisible();
  });
});
