import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatPrintDocument } from "@/lib/domain/chatPrintDocument";

const mocks = vi.hoisted(() => ({
  authorizeChatPage: vi.fn(async (pathname: string): Promise<void> => {
    throw new Error(`NEXT_REDIRECT /login?next=${pathname}`);
  }),
  load: vi.fn(),
  loadChatViewer: vi.fn(),
  noStore: vi.fn(),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  })
}));

vi.mock("@/app/(chat)/viewer", () => ({ authorizeChatPage: mocks.authorizeChatPage, loadChatViewer: mocks.loadChatViewer }));
vi.mock("@/lib/server/chats/printChat", () => ({ loadAuthorizedChatPrintDocument: mocks.load }));
vi.mock("@/lib/server/prisma", () => ({ prisma: { tag: "prisma" } }));
vi.mock("next/cache", () => ({ unstable_noStore: mocks.noStore }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/features/print-v2/ChatPrintViewV2", () => ({
  ChatPrintViewV2: ({ document }: { document: ChatPrintDocument }) => <p data-testid="print-view">{document.title}</p>
}));

import ChatPrintPage, { dynamic, generateMetadata, revalidate } from "./page";

const printDocument: ChatPrintDocument = {
  createdAt: "2026-09-01T12:00:00.000Z",
  fileBaseName: "отчёт-2026-10-05",
  title: "Отчёт",
  turns: [],
  updatedAt: "2026-09-01T12:00:00.000Z"
};
const params = (chatId: string) => ({ params: Promise.resolve({ chatId }) });

afterEach(() => {
  vi.clearAllMocks();
});

describe("chat print page route", () => {
  it("is uncached", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(revalidate).toBe(0);
  });

  it("renders the viewer's chat and proposes the export base name as the PDF file name", async () => {
    mocks.loadChatViewer.mockResolvedValue({ accountId: "user-1" });
    mocks.load.mockResolvedValue(printDocument);
    render(await ChatPrintPage(params("chat-1")));
    expect(screen.getByTestId("print-view")).toHaveTextContent("Отчёт");
    expect(mocks.noStore).toHaveBeenCalled();
    expect(mocks.load).toHaveBeenCalledWith({ tag: "prisma" }, { chatId: "chat-1", userId: "user-1" });
    expect(await generateMetadata(params("chat-1"))).toEqual({
      robots: { follow: false, index: false, nocache: true },
      title: { absolute: "отчёт-2026-10-05" }
    });
  });

  it("gives a missing and an inaccessible chat the same not-found response", async () => {
    mocks.loadChatViewer.mockResolvedValue({ accountId: "stranger" });
    mocks.load.mockResolvedValue(null);
    for (const chatId of ["someone-elses-chat", "no-such-chat"]) {
      await expect(ChatPrintPage(params(chatId))).rejects.toThrow("NEXT_NOT_FOUND");
      expect(await generateMetadata(params(chatId))).toMatchObject({ title: "Chat not found" });
    }
  });

  it("sends a signed-out reader to sign in and back to this print page", async () => {
    mocks.loadChatViewer.mockResolvedValue(null);
    await expect(ChatPrintPage(params("chat 1"))).rejects.toThrow("NEXT_REDIRECT /login?next=/print/c/chat%201");
    expect(mocks.load).not.toHaveBeenCalled();
  });
});
