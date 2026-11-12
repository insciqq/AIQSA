import { DISCORD_SNOWFLAKE_PATTERN } from "../../../contracts/discord";
import { discordSnowflakeTime } from "../intake";

/**
 * Discord messages as the run context reads them (PRD D-16): who wrote them
 * (server nickname, else global name, else username, with the Discord id),
 * when, their text with mentions written as names, the text of their embeds
 * (another service's cards are embeds), and their attachments by name. A
 * message the gateway sent and one read through REST decode alike.
 */

/** DEFAULT, REPLY, and the two application-command result types another bot's posts use; every other type is a system message. */
export const DISCORD_CONTEXT_MESSAGE_TYPES: ReadonlySet<number> = new Set([0, 19, 20, 23]);
const NAME_MAX = 64;
const EMBED_TEXT_MAX = 2_000;
const ATTACHMENTS_MAX = 25;
const FILENAME_MAX = 200;

export type DiscordContextAttachment = Readonly<{
  id: string;
  filename: string;
  contentType: string | null;
  size: number | null;
  /** Signed CDN addresses; never logged. */
  url: string | null;
  proxyUrl: string | null;
}>;

export type DiscordContextMessage = Readonly<{
  id: string;
  channelId: string;
  type: number;
  authorId: string;
  /** Server nickname, else global name, else username. */
  authorName: string;
  /** A bot or a webhook wrote it. */
  bot: boolean;
  createdAt: Date;
  /** The text with user, role and channel mentions written as names, embeds' text after it. */
  text: string;
  attachments: readonly DiscordContextAttachment[];
  /** The message this one replies to. */
  referenceId: string | null;
  referenceChannelId: string | null;
  mentionUserIds: readonly string[];
  mentionRoleIds: readonly string[];
}>;

export type DiscordMentionNames = Readonly<{ botUserId: string; botRoleId: string | null; botName: string }>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function snowflake(value: unknown): string | null {
  return typeof value === "string" && DISCORD_SNOWFLAKE_PATTERN.test(value) ? value : null;
}

function name(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, NAME_MAX);
  return cleaned || null;
}

/** A user object's display name: the member's nickname, else the global name, else the username. */
export function discordDisplayName(user: unknown, member?: unknown): string {
  const author = record(user);
  return name(record(member)?.nick) ?? name(author?.global_name) ?? name(author?.username) ?? "Discord user";
}

function embedText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const entry of value.slice(0, 10)) {
    const embed = record(entry);
    if (!embed) continue;
    const lines: string[] = [];
    for (const value of [embed.title, embed.description]) {
      if (typeof value === "string" && value.trim()) lines.push(value.trim());
    }
    if (Array.isArray(embed.fields)) {
      for (const field of embed.fields.slice(0, 25)) {
        const item = record(field);
        const label = typeof item?.name === "string" ? item.name.trim() : "";
        const text = typeof item?.value === "string" ? item.value.trim() : "";
        if (label || text) lines.push(label && text ? `${label}: ${text}` : label || text);
      }
    }
    const footer = record(embed.footer)?.text;
    if (typeof footer === "string" && footer.trim()) lines.push(footer.trim());
    if (lines.length > 0) parts.push(`[embed] ${lines.join("\n")}`);
  }
  const joined = parts.join("\n");
  return joined.length > EMBED_TEXT_MAX ? `${joined.slice(0, EMBED_TEXT_MAX)}…` : joined;
}

function attachments(value: unknown): DiscordContextAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, ATTACHMENTS_MAX).flatMap((entry) => {
    const attachment = record(entry);
    const id = snowflake(attachment?.id);
    if (!attachment || !id) return [];
    const filename = typeof attachment.filename === "string" && attachment.filename.trim()
      ? attachment.filename.replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, FILENAME_MAX) : "file";
    return [{
      contentType: typeof attachment.content_type === "string" ? attachment.content_type.slice(0, 200) : null,
      filename,
      id,
      proxyUrl: typeof attachment.proxy_url === "string" ? attachment.proxy_url : null,
      size: Number.isSafeInteger(attachment.size) ? attachment.size as number : null,
      url: typeof attachment.url === "string" ? attachment.url : null
    }];
  });
}

/** Mentions written as names: `@name`, the bot's role as the bot, other roles as `@role`, channels as `#channel`, custom emoji as `:name:`. */
export function discordMentionText(content: string, mentions: unknown, names: DiscordMentionNames): string {
  const users = new Map<string, string>();
  if (Array.isArray(mentions)) {
    for (const entry of mentions.slice(0, 100)) {
      const user = record(entry);
      const id = snowflake(user?.id);
      if (id) users.set(id, discordDisplayName(user, user?.member));
    }
  }
  return content
    .replace(/<@!?([0-9]{1,20})>/gu, (_match, id: string) => `@${id === names.botUserId ? names.botName : users.get(id) ?? "user"}`)
    .replace(/<@&([0-9]{1,20})>/gu, (_match, id: string) => (id === names.botRoleId ? `@${names.botName}` : "@role"))
    .replace(/<#[0-9]{1,20}>/gu, "#channel")
    .replace(/<a?:([A-Za-z0-9_]{1,32}):[0-9]{1,20}>/gu, ":$1:");
}

/** A gateway or REST message for the context; null when it is not a usable message. */
export function decodeDiscordContextMessage(value: unknown, names: DiscordMentionNames): DiscordContextMessage | null {
  const payload = record(value);
  const id = snowflake(payload?.id);
  const channelId = snowflake(payload?.channel_id);
  const author = record(payload?.author);
  const authorId = snowflake(author?.id);
  if (!payload || !id || !channelId || !author || !authorId) return null;
  const reference = record(payload.message_reference);
  const sentAt = typeof payload.timestamp === "string" ? Date.parse(payload.timestamp) : Number.NaN;
  const content = typeof payload.content === "string" ? payload.content : "";
  const embeds = embedText(payload.embeds);
  const text = [discordMentionText(content, payload.mentions, names).trim(), embeds].filter(Boolean).join("\n");
  return {
    attachments: attachments(payload.attachments),
    authorId,
    authorName: discordDisplayName(author, payload.member),
    bot: author.bot === true || snowflake(payload.webhook_id) !== null,
    channelId,
    createdAt: new Date(Number.isFinite(sentAt) ? sentAt : discordSnowflakeTime(id)),
    id,
    mentionRoleIds: Array.isArray(payload.mention_roles) ? payload.mention_roles.flatMap((entry) => snowflake(entry) ?? []) : [],
    mentionUserIds: Array.isArray(payload.mentions) ? payload.mentions.flatMap((entry) => snowflake(record(entry)?.id) ?? []) : [],
    referenceChannelId: snowflake(reference?.channel_id),
    referenceId: snowflake(reference?.message_id),
    text,
    type: typeof payload.type === "number" && Number.isSafeInteger(payload.type) ? payload.type : -1
  };
}

/** Ascending snowflake order. */
export function compareDiscordIds(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `[2026-11-12 09:00 UTC]`. */
export function discordLineTime(at: Date): string {
  return `[${at.toISOString().slice(0, 16).replace("T", " ")} UTC]`;
}

/** `Alice (discord:123)`, a bot's post marked `(bot)`. */
export function discordAuthorLabel(message: Pick<DiscordContextMessage, "authorId" | "authorName" | "bot">): string {
  return `${message.authorName} (discord:${message.authorId})${message.bot ? " (bot)" : ""}`;
}

/** Attachments by name, as the text names them when no file goes with the turn. */
export function discordAttachmentNames(message: Pick<DiscordContextMessage, "attachments">): string {
  return message.attachments.length > 0 ? ` [attachments: ${message.attachments.map((attachment) => attachment.filename).join(", ")}]` : "";
}

/** One history line: `[time UTC] Name (discord:id): text [attachments: …]`. */
export function discordHistoryLine(message: DiscordContextMessage): string {
  return `${discordLineTime(message.createdAt)} ${discordAuthorLabel(message)}: ${message.text}${discordAttachmentNames(message)}`;
}
