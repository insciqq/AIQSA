import type { ChatImportSource } from "@/lib/contracts/chatImport";

/** Product names of the import sources as users know them. */
export const CHAT_IMPORT_SOURCE_NAMES: Readonly<Record<ChatImportSource, string>> = Object.freeze({
  AIQSA: "AIQSA",
  CHATGPT: "ChatGPT",
  CLAUDE: "Claude"
});

/** The chat header's provenance line for an imported chat (and its copies). */
export function importedFromLabel(source: ChatImportSource): string {
  return `Imported from ${CHAT_IMPORT_SOURCE_NAMES[source]}`;
}
