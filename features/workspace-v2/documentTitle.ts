/**
 * Browser tab title for the v2 shell, per the product/layout contract: the
 * title follows the visible active chat, `New chat` is the blank-workspace
 * fallback, and the Library replaces it while it owns the workspace. The
 * `· AIQSA` suffix matches the root metadata template and Control Center.
 */
export function documentTitleV2(input: Readonly<{
  activeChatId: string | null;
  activeChatTitle: string;
  libraryOpen: boolean;
}>): string {
  if (input.libraryOpen) return "Library · AIQSA";
  const title = input.activeChatId ? input.activeChatTitle.trim() : "";
  return `${title || "New chat"} · AIQSA`;
}
