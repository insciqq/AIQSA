import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceExportHistoryV2 } from "./WorkspaceExportHistoryV2";

const file = (id: string, fileName: string) => ({ attachmentId: id, byteSize: 1024, fileName, mimeType: "text/plain", relativePath: fileName });
const entry = (messageId: string, files = [file("spreadsheet", "report.xlsx")]) => ({ createdAt: "2026-09-05T00:00:00.000Z", files, messageId });
afterEach(() => { vi.unstubAllGlobals(); });

describe("Workspace export history", () => {
  it("shows an answer's files together with downloads, date, navigation and exact-file reuse", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ exports: [entry("answer", [file("spreadsheet", "report.xlsx"), file("slides", "meeting.pptx")])], nextCursor: null })));
    const onMessage = vi.fn();
    const onClose = vi.fn();
    const onUse = vi.fn(async () => true);
    render(<WorkspaceExportHistoryV2 branchKey="leaf" canSave={false} chatId="chat" onClose={onClose} onMessage={onMessage} onUse={onUse} />);
    const dialog = screen.getByRole("dialog", { name: "Export history" });
    expect(await within(dialog).findByText("report.xlsx")).toBeVisible();
    expect(within(dialog).getByText("meeting.pptx")).toBeVisible();
    expect(within(dialog).getAllByRole("button", { name: "Go to answer" })).toHaveLength(1);
    expect(dialog.querySelector("time")).toHaveAttribute("datetime", "2026-09-05T00:00:00.000Z");
    expect(within(dialog).getAllByRole("link", { name: "Download" }).map((link) => link.getAttribute("href")))
      .toEqual(["/api/attachments/spreadsheet/content", "/api/attachments/slides/content"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Go to answer" }));
    expect(onMessage).toHaveBeenCalledWith("answer");
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Use file" })[1]!);
    await waitFor(() => expect(onUse).toHaveBeenCalledWith("slides", "meeting.pptx"));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("discards an old chat response after navigation and keeps errors actionable", async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }))
      .mockResolvedValueOnce(Response.json({}, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ exports: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetch);
    const props = { branchKey: "leaf", canSave: false, onClose: vi.fn(), onMessage: vi.fn() };
    const { rerender } = render(<WorkspaceExportHistoryV2 {...props} chatId="old-chat" />);
    rerender(<WorkspaceExportHistoryV2 {...props} chatId="new-chat" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Export history could not be loaded");
    resolve(Response.json({ exports: [entry("old-answer")], nextCursor: null }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No completed exports yet.")).toBeVisible();
    expect(screen.queryByText("report.xlsx")).not.toBeInTheDocument();
  });
});
