import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetFileLibraryStoreForTest } from "@/components/app-shell/fileLibraryStore";
import { SavedFilePickerV2 } from "./SavedFilePickerV2";
import { SaveFileButtonV2 } from "./SaveFileButtonV2";

const saved = {
  byteSize: 2048, chatId: null, chatTitle: null, createdAt: "2026-09-05T00:00:00.000Z",
  fileName: "Application.docx", id: "saved-document", messageId: null,
  savedAt: "2026-09-05T00:00:00.000Z", status: "ready"
};

afterEach(() => { resetFileLibraryStoreForTest(); vi.unstubAllGlobals(); });

describe("saved file controls", () => {
  it("does not close a later surface when reuse finishes after the picker was dismissed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ nextCursor: null, files: [saved] })));
    let finish!: (value: boolean) => void;
    const result = new Promise<boolean>((resolve) => { finish = resolve; });
    const onUsed = vi.fn();
    const view = render(<SavedFilePickerV2 onUse={() => result} onUsed={onUsed} />);
    fireEvent.click(await screen.findByRole("button", { name: "Use file" }));
    view.unmount();
    await act(async () => { finish(true); await result; });
    expect(onUsed).not.toHaveBeenCalled();
  });

  it("lets the user find and select a saved template without selecting a recent chat attachment", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ nextCursor: null, files: [saved, {
      ...saved, chatId: "chat", chatTitle: "Source chat", id: "recent-file", messageId: "message", savedAt: null, fileName: "Recent.csv"
    }] })));
    const onUse = vi.fn(async () => true);
    render(<SavedFilePickerV2 onUse={onUse} />);
    expect(await screen.findByText("Application.docx")).toBeVisible();
    expect(screen.queryByText("Recent.csv")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Find saved files" }), { target: { value: "application" } });
    fireEvent.click(screen.getByRole("button", { name: "Use file" }));
    await waitFor(() => expect(onUse).toHaveBeenCalledWith("saved-document", "Application.docx"));
  });

  it("shows load failure and can retry into an empty Library", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({}, { status: 503 })).mockResolvedValueOnce(Response.json({ nextCursor: null, files: [] })));
    render(<SavedFilePickerV2 onUse={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Files could not be loaded");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Save a file from a message or Library to use it here.")).toBeVisible();
  });

  it("keeps save retryable and disables another save after confirmed success", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({}, { status: 500 }))
      .mockResolvedValueOnce(Response.json({ attachment: { fileName: saved.fileName, id: saved.id, kind: "file", status: "ready" } }))
      .mockResolvedValueOnce(Response.json({ nextCursor: null, files: [saved] }));
    vi.stubGlobal("fetch", fetch);
    render(<SaveFileButtonV2 attachmentId="source-file" />);
    fireEvent.click(screen.getByRole("button", { name: "Save to Library" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save");
    fireEvent.click(screen.getByRole("button", { name: "Save to Library" }));
    expect(await screen.findByRole("button", { name: "Saved to Library" })).toBeDisabled();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  });
});
