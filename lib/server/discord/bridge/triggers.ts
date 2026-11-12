import type { DiscordChannelKind } from "../access";
import type { DiscordIntakeMessage } from "../intake";

/**
 * Whether a message that passed intake asks the bot (PRD D-11, O-37): a direct
 * message; a mention of the bot user or of its managed role; a Reply to a
 * message the bot user wrote (AIQSA's answers and the other service's posts
 * alike); or a message that starts with one of the installation's call names.
 * Elsewhere, threads the bot opened included, people talking to each other are
 * never answered, though their messages stay in the next turn's context.
 * `@everyone` and `@here` alone ask nothing.
 */

export type DiscordTrigger = "dm" | "mention" | "role_mention" | "reply_to_bot" | "call_name";

export type DiscordCallNameMatch = Readonly<{
  /** The call name as the administrator saved it. */
  name: string;
  /** The text after the name and its delimiter: what the question asks. */
  rest: string;
}>;

const DELIMITERS = ",:\\-–—";
const MATCHERS_MAX = 64;
const matchers = new Map<string, RegExp>();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
}

/**
 * `^\s*NAME` then a delimiter: a comma, colon or dash (spaces around it allowed), or whitespace alone; then
 * non-empty text. The character after the name is never a letter, digit or underscore, so "Agentry" or "Agents"
 * does not answer to "Agent". Unicode case-insensitive; spaces inside a name match any run of whitespace.
 */
function matcher(name: string): RegExp {
  let pattern = matchers.get(name);
  if (!pattern) {
    const body = name.trim().split(/\s+/u).map(escapeRegExp).join("\\s+");
    pattern = new RegExp(`^\\s*${body}(?![\\p{L}\\p{N}\\p{M}_])(?:\\s*[${DELIMITERS}]\\s*|\\s+)(?=\\S)`, "iu");
    if (matchers.size >= MATCHERS_MAX) matchers.clear();
    matchers.set(name, pattern);
  }
  return pattern;
}

/** The longest call name the text starts with, and the text after it; null when none does or nothing follows. */
export function discordCallNameMatch(text: string, callNames: readonly string[]): DiscordCallNameMatch | null {
  let best: { name: string; length: number } | null = null;
  for (const name of callNames) {
    if (!name.trim()) continue;
    const found = matcher(name).exec(text);
    // The longest name wins, so "Agent Smith, hi" is not read as "Agent" asking "Smith, hi".
    if (found && (!best || name.trim().length > best.name.trim().length)) best = { length: found[0].length, name };
  }
  return best ? { name: best.name, rest: text.slice(best.length) } : null;
}

export function discordTrigger(input: Readonly<{
  message: DiscordIntakeMessage;
  kind: DiscordChannelKind;
  botUserId: string;
  botRoleId: string | null;
  callNames: readonly string[];
}>): DiscordTrigger | null {
  const { message } = input;
  if (input.kind === "dm") return "dm";
  if (message.mentionUserIds.includes(input.botUserId)) return "mention";
  if (input.botRoleId && message.mentionRoleIds.includes(input.botRoleId)) return "role_mention";
  if (message.reference && message.referencedAuthorId === input.botUserId) return "reply_to_bot";
  return discordCallNameMatch(message.content, input.callNames) ? "call_name" : null;
}
