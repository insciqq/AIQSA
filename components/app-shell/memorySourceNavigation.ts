import type { ChatSummary } from "@/components/app-shell/types";
import type { ChatSourceResolutionResponseWire } from "@/lib/contracts/chats";

export type MemorySourceNavigationDeps = Readonly<{
  activateChat(chat: ChatSummary): Promise<unknown> | unknown;
  closeResolvedOverlay?(): void;
  findActiveChat(chatId: string): ChatSummary | null;
  openArchivedPreview(chatId: string): Promise<unknown> | unknown;
  refreshWorkspace(chatId: string): Promise<unknown> | unknown;
  resolveSource(chatId: string): Promise<ChatSourceResolutionResponseWire>;
}>;

export async function navigateMemorySource(
  chatId: string,
  deps: MemorySourceNavigationDeps
): Promise<"ACTIVE_CHAT" | "ARCHIVED_PREVIEW"> {
  const resolution = await deps.resolveSource(chatId);
  // Resolve ownership/location before dismissing the current private surface.
  deps.closeResolvedOverlay?.();
  if (resolution.source.location === "ARCHIVED_PREVIEW") {
    await deps.openArchivedPreview(chatId);
    return "ARCHIVED_PREVIEW";
  }
  const sourceChat = deps.findActiveChat(chatId);
  if (sourceChat) await deps.activateChat(sourceChat);
  else await deps.refreshWorkspace(chatId);
  return "ACTIVE_CHAT";
}
