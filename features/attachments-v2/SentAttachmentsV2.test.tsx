import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeneratedFilesV2 } from "@/features/answer-outputs-v2/AnswerOutputsV2";
import { FilesPanelV2 } from "@/features/library-v2/LibraryV2";
import { SentAttachmentsV2 } from "./SentAttachmentsV2";

vi.mock("@/features/pdf-viewer-v2/PdfViewerV2", () => ({
  PdfViewerV2: (props: { canSave: boolean; fileId: string }) => <div data-can-save={String(props.canSave)} data-testid="pdf-stub">{props.fileId}</div>
}));

const file = (attachmentId: string, label: string) => ({ attachmentId, label, type: "file" as const });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("where a PDF opens the viewer", () => {
  it("a sent PDF card opens it with Download, and focus returns to the card on close", async () => {
    render(<SentAttachmentsV2 blocks={[file("a", "отчёт.PDF"), file("b", "table.docx")]} canSave />);
    expect(screen.getByRole("link", { name: "Download table.docx" })).toBeVisible();
    const card = screen.getByRole("button", { name: "Open отчёт.PDF" });
    card.focus();
    fireEvent.click(card);
    expect(await screen.findByTestId("pdf-stub")).toHaveAttribute("data-can-save", "true");
    expect(screen.getByRole("link", { name: "Download отчёт.PDF" })).toHaveAttribute("href", "/api/attachments/a/content");
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    await waitFor(() => expect(screen.queryByTestId("pdf-stub")).toBeNull());
    await waitFor(() => expect(card).toHaveFocus());
  });

  it("a temporary chat's card opens it without Save to Files", async () => {
    render(<SentAttachmentsV2 blocks={[file("a", "note.pdf")]} />);
    fireEvent.click(screen.getByRole("button", { name: "Open note.pdf" }));
    expect(await screen.findByTestId("pdf-stub")).toHaveAttribute("data-can-save", "false");
  });

  it("an answer's generated PDF opens it from its name; an oversized one stays a download", async () => {
    const generated = { attachmentId: "g", byteSize: 2_000, fileName: "итог.pdf", mimeType: "application/pdf", relativePath: "output/итог.pdf" };
    const { rerender } = render(<GeneratedFilesV2 canSave files={[{ ...generated, byteSize: 70_000_000 }] as never} />);
    expect(screen.queryByRole("button", { name: "итог.pdf" })).toBeNull();
    rerender(<GeneratedFilesV2 canSave files={[generated] as never} />);
    fireEvent.click(screen.getByRole("button", { name: "итог.pdf" }));
    expect(await screen.findByTestId("pdf-stub")).toHaveTextContent("g");
  });

  it("the library offers View on an eligible PDF and opens it", async () => {
    render(<FilesPanelV2 files={[{
      id: "lib", name: "notes.pdf", byteSize: 100, canOpenChat: false, chatId: null, chatTitle: null,
      createdAt: "2026-09-22T00:00:00.000Z", savedAt: null, previewKind: "pdf", status: "ready"
    }]} onSave={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "View notes.pdf" }));
    expect(await screen.findByTestId("pdf-stub")).toHaveAttribute("data-can-save", "true");
  });
});
