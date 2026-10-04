import type { Metadata } from "next";
import { unstable_noStore as noStore } from "next/cache";
import { notFound } from "next/navigation";
import { cache } from "react";
import { authorizeChatPage, loadChatViewer } from "@/app/(chat)/viewer";
import { ChatPrintViewV2 } from "@/features/print-v2/ChatPrintViewV2";
import type { ChatPrintDocument } from "@/lib/domain/chatPrintDocument";
import { loadAuthorizedChatPrintDocument } from "@/lib/server/chats/printChat";
import { prisma } from "@/lib/server/prisma";
import "@/features/print-v2/print.css";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type ChatPrintPageProps = Readonly<{ params: Promise<{ chatId: string }> }>;

/** One authorized read per request, shared by the metadata and the page. */
const loadPrintDocument = cache(async (chatId: string): Promise<ChatPrintDocument | "signed_out" | null> => {
  const viewer = await loadChatViewer();
  if (!viewer) return "signed_out";
  return loadAuthorizedChatPrintDocument(prisma, { chatId, userId: viewer.accountId });
});

export async function generateMetadata({ params }: ChatPrintPageProps): Promise<Metadata> {
  const document = await loadPrintDocument((await params).chatId);
  return {
    robots: { follow: false, index: false, nocache: true },
    // "Save as PDF" proposes the page title as the file name.
    title: document && document !== "signed_out" ? { absolute: document.fileBaseName } : "Chat not found"
  };
}

/**
 * A shell-free print page of a chat's whole visible branch. It authorizes
 * exactly like opening the chat; an invisible chat is indistinguishable from
 * a missing one.
 */
export default async function ChatPrintPage({ params }: ChatPrintPageProps) {
  noStore();
  const { chatId } = await params;
  const document = await loadPrintDocument(chatId);
  if (document === "signed_out") {
    await authorizeChatPage(`/print/c/${encodeURIComponent(chatId)}`, new URLSearchParams());
    notFound();
  }
  if (!document) notFound();
  return <ChatPrintViewV2 document={document} />;
}
