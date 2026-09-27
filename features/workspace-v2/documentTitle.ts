import { chatTitleForDisplay } from "@/components/app-shell/shellFormatting";

/**
 * Browser tab title for the v2 shell, per the product/layout contract: the
 * title follows the visible active chat, `New chat` is the blank-workspace
 * fallback, and the Library replaces it while it owns the workspace. An
 * address that names a chat still being opened keeps the neutral `Chat`
 * page title instead of claiming a new chat. The `· AIQSA` suffix matches the
 * root metadata template and Control Center.
 */
export function documentTitleV2(input: Readonly<{
  activeChatId: string | null;
  activeChatTitle: string;
  libraryOpen: boolean;
  routeChatId?: string | null;
}>): string {
  if (input.libraryOpen) return "Studio · AIQSA";
  const title = input.activeChatId
    ? chatTitleForDisplay(input.activeChatTitle)
    : input.routeChatId ? "Chat" : "New chat";
  return `${title} · AIQSA`;
}
