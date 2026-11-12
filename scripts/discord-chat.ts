// Prints one Discord chat's active branch for the weekly review (PRD D-38), run inside the app container:
//   docker compose exec app node --import tsx scripts/discord-chat.ts <chatId>
// Only a chat bound to a Discord conversation of a service account is printed: each message's role, time and
// text, files by name. Any other id answers "not a Discord chat". There is no HTTP route; access is the host's.
// Nothing is logged. Exit codes: 0 printed, 1 not a Discord chat, 2 usage, 3 the database could not be read.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ChatExportDocumentMessage } from "../lib/contracts/chatExport";
import { chatExportDocumentChat, type ChatExportSource } from "../lib/domain/chatExportDocument";

export const DISCORD_CHAT_USAGE = "Usage: node --import tsx scripts/discord-chat.ts <chatId>";
export const NOT_A_DISCORD_CHAT = "not a Discord chat";
const CHAT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
/** The longest branch printed; a longer one names how many earlier messages were left out. */
const BRANCH_MAX = 20_000;

export type DiscordChatRepository = Readonly<{
  /** The owner of the chat's Discord conversation and whether that account is a service account; null without one. */
  conversationOwner(chatId: string): Promise<Readonly<{ userId: string; service: boolean }> | null>;
  /** The chat as its owner's export reads it; null when the owner cannot read it. */
  loadChat(input: Readonly<{ chatId: string; userId: string }>): Promise<ChatExportSource | null>;
}>;

export type DiscordChatOutcome = Readonly<{ kind: "printed"; text: string }> | Readonly<{ kind: "refused" }>;

/** Root to leaf of the export's active branch, follow-up turns included. */
function activeBranch(messages: readonly ChatExportDocumentMessage[], leafId: string | null): ChatExportDocumentMessage[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const path: ChatExportDocumentMessage[] = [];
  const seen = new Set<string>();
  let cursor = leafId;
  while (cursor && !seen.has(cursor)) {
    const message = byId.get(cursor);
    if (!message) break;
    seen.add(cursor);
    path.push(message);
    cursor = message.parentId;
  }
  return path.reverse();
}

export function formatDiscordChat(chatId: string, source: ChatExportSource): string {
  const chat = chatExportDocumentChat(source);
  const branch = activeBranch(chat.messages, chat.activeLeafId);
  const shown = branch.slice(-BRANCH_MAX);
  const lines = [`Discord chat ${chatId}: ${chat.title}`, `${branch.length} messages on the active branch`];
  if (shown.length < branch.length) lines.push(`${branch.length - shown.length} earlier messages omitted`);
  for (const message of shown) {
    lines.push("", `[${message.role}] ${message.createdAt}${message.status === "complete" ? "" : ` (${message.status})`}`);
    if (message.text) lines.push(message.text);
    if (message.attachments?.length) lines.push(`Files: ${message.attachments.map((file) => file.name).join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Prints a chat only when it is a Discord conversation's chat of a service account. */
export async function readDiscordChat(repository: DiscordChatRepository, chatId: string): Promise<DiscordChatOutcome> {
  if (!CHAT_ID.test(chatId)) return { kind: "refused" };
  const owner = await repository.conversationOwner(chatId);
  if (!owner?.service) return { kind: "refused" };
  const source = await repository.loadChat({ chatId, userId: owner.userId });
  return source ? { kind: "printed", text: formatDiscordChat(chatId, source) } : { kind: "refused" };
}

async function main(): Promise<void> {
  // stdout carries only the chat: a record any reused service writes goes to stderr.
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === "--help") {
    process.stderr.write(`${DISCORD_CHAT_USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  // Loaded only now so a usage error never opens a database client.
  const [{ prisma }, { loadAuthorizedChatExportSource }] = await Promise.all([
    import("../lib/server/prisma"), import("../lib/server/chats/exportChat")
  ]);
  const repository: DiscordChatRepository = {
    async conversationOwner(chatId) {
      const conversation = await prisma.discordConversation.findUnique({ select: { userId: true }, where: { chatId } });
      if (!conversation) return null;
      const user = await prisma.user.findUnique({ select: { kind: true }, where: { id: conversation.userId } });
      return { service: user?.kind === "service", userId: conversation.userId };
    },
    loadChat: (input) => loadAuthorizedChatExportSource(prisma, input)
  };
  try {
    const outcome = await readDiscordChat(repository, args[0]!);
    if (outcome.kind === "printed") {
      write(outcome.text);
    } else {
      process.stderr.write(`${NOT_A_DISCORD_CHAT}\n`);
      process.exitCode = 1;
    }
  } catch {
    process.stderr.write("Cannot read the chat (database unavailable).\n");
    process.exitCode = 3;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => {
    process.stderr.write("Cannot read the chat (startup).\n");
    process.exitCode = 3;
  });
}
