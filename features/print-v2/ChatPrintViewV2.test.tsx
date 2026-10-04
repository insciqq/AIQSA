import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatPrintDocument } from "@/lib/domain/chatPrintDocument";
import { ChatPrintUnavailableV2, ChatPrintViewV2 } from "./ChatPrintViewV2";

const printDocument: ChatPrintDocument = {
  createdAt: "2026-09-01T12:00:00.000Z",
  fileBaseName: "отчёт-2026-10-05",
  title: "Отчёт",
  turns: [
    { files: ["plan.pdf"], images: [{ attachmentId: "att 1", label: "Схема склада" }], role: "user", text: "Привет, **мир**" },
    { files: [], images: [{ attachmentId: "gen-1", height: 768, label: "Generated image", width: 1024 }], role: "assistant",
      text: "| A | B |\n| - | - |\n| 1 | 2 |" }
  ],
  updatedAt: "2026-09-02T12:00:00.000Z"
};

let print: ReturnType<typeof vi.fn>;

beforeEach(() => {
  print = vi.fn();
  vi.stubGlobal("print", print);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  // jsdom never loads image bytes; treat images as settled.
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  document.documentElement.dataset.theme = "dark";
  document.documentElement.dataset.colorScheme = "dark";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.title = "";
});

describe("chat print page", () => {
  it("renders every turn with speakers, Markdown, images through the authorized route and file names", () => {
    render(<ChatPrintViewV2 document={printDocument} />);
    expect(screen.getByRole("heading", { level: 1, name: "Отчёт" })).toBeVisible();
    const turns = within(screen.getByTestId("chat-print-thread")).getAllByRole("article");
    expect(turns.map((turn) => turn.getAttribute("aria-label"))).toEqual(["User", "Assistant"]);
    expect(within(turns[0]!).getByText("мир").tagName).toBe("STRONG");
    expect(within(turns[1]!).getByRole("table")).toBeVisible();
    const question = within(turns[0]!).getByRole("img", { name: "Схема склада" });
    expect(question).toHaveAttribute("src", "/api/attachments/att%201/content?preview=image");
    expect(question).toHaveAttribute("loading", "eager");
    expect(within(turns[1]!).getByRole("img", { name: "Generated image" })).toHaveAttribute("width", "1024");
    expect(within(turns[0]!).getByText("Attachment: plan.pdf")).toBeVisible();
  });

  it("uses the light theme for paper, then names the document and prints once after rendering settles", async () => {
    const view = render(<ChatPrintViewV2 document={printDocument} />);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.colorScheme).toBe("light");
    expect(screen.getByTestId("chat-print-page")).toHaveAttribute("data-print-state", "preparing");
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    expect(document.title).toBe("отчёт-2026-10-05");
    expect(screen.getByTestId("chat-print-page")).toHaveAttribute("data-print-state", "ready");
    expect(screen.getByTestId("chat-print-page")).toHaveAttribute("data-print-settle", "settled");
    view.rerender(<ChatPrintViewV2 document={printDocument} />);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(print).toHaveBeenCalledTimes(1);

    // The visible button stays for browsers that suppress the automatic dialog.
    fireEvent.click(screen.getByRole("button", { name: "Print / Save as PDF" }));
    expect(print).toHaveBeenCalledTimes(2);
  });

  it("waits for a pending highlighted code block before printing", async () => {
    let finish!: (value: { html: string; language: "ts" } | null) => void;
    const highlighting = await import("@/components/chat/codeHighlighting");
    vi.spyOn(highlighting, "highlightCodeBlock").mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<ChatPrintViewV2 document={{ ...printDocument, turns: [{ files: [], images: [], role: "assistant", text: "```ts\nconst a = 1;\n```" }] }} />);
    expect(document.querySelector("[data-render-pending]")).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(print).not.toHaveBeenCalled();
    finish(null);
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    expect(document.querySelector("[data-render-pending]")).toBeNull();
  });

  it("shows an empty branch plainly", () => {
    render(<ChatPrintViewV2 document={{ ...printDocument, turns: [] }} />);
    expect(screen.getByText("This chat has no messages to print.")).toBeVisible();
  });

  it("answers a missing and an inaccessible chat with the same neutral page", () => {
    render(<ChatPrintUnavailableV2 />);
    expect(screen.getByRole("heading", { name: "Chat not found" })).toBeVisible();
    expect(screen.getByText("This chat does not exist or you do not have access to it.")).toBeVisible();
  });
});
