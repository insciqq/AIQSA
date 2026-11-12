import type { DiscordChannelKind } from "../access";
import type { DiscordIntakeMessage } from "../intake";

/**
 * Whether a message that passed intake asks the bot (PRD D-11, O-13): a direct
 * message; a mention of the bot user or of its managed role; a Reply to a
 * message the bot user wrote (AIQSA's answers and the other service's posts
 * alike); or, in a thread AIQSA opened, any person's message except a Reply to
 * someone else and a message that mentions people or roles but not the bot,
 * so people talking to each other there are never interrupted. `@everyone` and
 * `@here` alone ask nothing.
 */

export type DiscordTrigger = "dm" | "mention" | "role_mention" | "reply_to_bot" | "bot_thread";

export function discordTrigger(input: Readonly<{
  message: DiscordIntakeMessage;
  kind: DiscordChannelKind;
  botUserId: string;
  botRoleId: string | null;
  /** The message is in a thread AIQSA opened (`DiscordConversation.botOpened`). */
  botOpenedThread: boolean;
}>): DiscordTrigger | null {
  const { message } = input;
  if (input.kind === "dm") return "dm";
  if (message.mentionUserIds.includes(input.botUserId)) return "mention";
  if (input.botRoleId && message.mentionRoleIds.includes(input.botRoleId)) return "role_mention";
  if (message.reference && message.referencedAuthorId === input.botUserId) return "reply_to_bot";
  if (!input.botOpenedThread) return null;
  // A Reply to anyone but the bot (a deleted target included) is people talking to each other.
  if (message.reference) return null;
  const mentionsOthers = message.mentionUserIds.some((id) => id !== input.botUserId) || message.mentionRoleIds.length > 0 ||
    message.mentionEveryone;
  return mentionsOthers ? null : "bot_thread";
}
