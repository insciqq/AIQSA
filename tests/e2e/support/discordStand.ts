import type { PrismaClient } from "@prisma/client";
import { expect, type APIRequestContext } from "@playwright/test";
import {
  DISCORD_LIMIT_DEFAULTS, type DiscordAdminActivity, type DiscordAdminCommand, type DiscordAdminState
} from "../../../lib/contracts/discord";
import { createFakeDiscord, FAKE_DISCORD_CHANNEL_TYPES, type FakeDiscord, type FakeDiscordMessage } from "../../support/fakeDiscord";
import { discordE2ePorts } from "./discordApiOrigin";

/**
 * Discord Connect on a browser stand: the fake Discord (REST, CDN and the
 * gateway over loopback, `tests/support/fakeDiscord.ts`) on the ports the
 * Playwright web server was given, the admin API, and what the bridge left
 * behind (its `DiscordReply` journal, the fake's messages and reactions).
 *
 * The fake runs on the wall clock (`liveClock`): the server drops messages
 * older than ten minutes or sent before Enable, and a reused stand keys its
 * journal by message id. The Discord control row is the installation's
 * singleton, so specs that use it run serially and leave the bot disabled;
 * the service account the product creates, its chats and its group
 * membership stay on the disposable stand and are reused by the next run.
 * Diagnostics name REST routes and statuses only, never message text.
 */

export const DISCORD_REPLY_TIMEOUT_MS = 45_000;
const SETTLED_STATES = ["delivered", "failed", "interrupted", "unknown"] as const;

export type DiscordStand = Readonly<{
  fake: FakeDiscord;
  /** Text channels the stand added, by name. */
  channels: Readonly<Record<string, string>>;
  stop(): Promise<void>;
}>;

/** Starts the fake on the stand's fixed ports with the default channels plus text channels named `extraChannels`. */
export async function startDiscordStand(extraChannels: readonly string[] = []): Promise<DiscordStand> {
  const fake = createFakeDiscord({ liveClock: true });
  const channels: Record<string, string> = {};
  for (const name of extraChannels) channels[name] = fake.addChannel({ name, type: FAKE_DISCORD_CHANNEL_TYPES.text });
  const server = await fake.start(discordE2ePorts());
  return { channels, fake, stop: server.stop };
}

// ---------------------------------------------------------------------------
// Admin API

type DiscordCommandBody = DiscordAdminCommand extends infer Command
  ? Command extends unknown ? Omit<Command, "expectedVersion"> : never
  : never;

export async function discordState(request: APIRequestContext): Promise<DiscordAdminState> {
  const response = await request.get("/api/admin/discord");
  expect(response.status(), "the Discord admin state is readable").toBe(200);
  return await response.json() as DiscordAdminState;
}

/** One admin command at the version just read; only the status is asserted, so a refusal body never reaches the report. */
export async function discordCommand(request: APIRequestContext, command: DiscordCommandBody): Promise<DiscordAdminState> {
  const { version } = await discordState(request);
  const response = await request.patch("/api/admin/discord", { data: { ...command, expectedVersion: version } });
  expect(response.status(), `Discord ${command.action}`).toBe(200);
  return await response.json() as DiscordAdminState;
}

export async function disableDiscord(request: APIRequestContext): Promise<void> {
  if ((await discordState(request)).enabled) await discordCommand(request, { action: "disable" });
}

export async function discordActivity(request: APIRequestContext): Promise<DiscordAdminActivity> {
  const response = await request.get("/api/admin/discord/activity");
  expect(response.status(), "the Discord activity is readable").toBe(200);
  return await response.json() as DiscordAdminActivity;
}

/**
 * Puts the service account into the full-access group through the admin API,
 * as an administrator gives it models (PRD §4.1 uses a group of its own; the
 * stand's seeded fake model is granted to full access).
 */
export async function grantServiceAccountFullAccess(request: APIRequestContext, prisma: PrismaClient, userId: string): Promise<void> {
  const fullAccess = await prisma.group.findUniqueOrThrow({ select: { id: true }, where: { systemRole: "full_access" } });
  const current = (await prisma.userGroup.findMany({ select: { groupId: true }, where: { group: { archivedAt: null }, userId } }))
    .map((membership) => membership.groupId);
  if (current.includes(fullAccess.id)) return;
  const response = await request.post("/api/admin/action", {
    data: { action: "set_user_groups", expectedGroupIds: current, groupIds: [...current, fullAccess.id], userId }
  });
  expect(response.status(), "the service account joins the full-access group").toBe(200);
}

/** Waits until the server's gateway session is ready on the fake. */
export async function waitForGateway(fake: FakeDiscord, request: APIRequestContext): Promise<void> {
  await expect.poll(() => fake.gateway.connections().some((connection) => connection.ready), {
    message: "the server opens a gateway session on the fake", timeout: 30_000
  }).toBe(true);
  await expect.poll(async () => (await discordState(request)).health.connected, { timeout: 30_000 }).toBe(true);
}

/**
 * The whole setup through the admin API (the UI path is covered by
 * `discord-connect.spec.ts`): token, the fake's server, Only listed channels,
 * Direct messages, the service account with full access, the Assistant,
 * default limits, then Enable and a ready gateway session.
 */
export async function configureDiscordByApi(request: APIRequestContext, prisma: PrismaClient, fake: FakeDiscord, input: Readonly<{
  assistantId: string; channelIds: readonly string[]; dmEnabled?: boolean;
}>): Promise<DiscordAdminState> {
  await disableDiscord(request);
  await discordCommand(request, { action: "test_and_save", token: fake.token });
  await discordCommand(request, { action: "set_guild", guildId: fake.guild.id });
  await discordCommand(request, { action: "set_channels", channelIds: [...input.channelIds], channelMode: "only_listed" });
  await discordCommand(request, { action: "set_direct_messages", dmEnabled: input.dmEnabled ?? false });
  let state = await discordState(request);
  if (state.serviceAccount.status === "missing") state = await discordCommand(request, { action: "create_service_account" });
  expect(state.serviceAccount.status).toBe("active");
  await grantServiceAccountFullAccess(request, prisma, state.serviceAccount.userId!);
  await discordCommand(request, { action: "set_assistant", assistantId: input.assistantId });
  await discordCommand(request, { action: "set_limits", limits: { ...DISCORD_LIMIT_DEFAULTS } });
  await discordCommand(request, { action: "set_test_access", testAuthorIds: [], testChannelIds: [] });
  state = await discordState(request);
  expect(state.setup.items.filter((item) => item.status === "blocking").map((item) => item.code), "no setup item blocks Enable").toEqual([]);
  state = await discordCommand(request, { action: "enable" });
  await waitForGateway(fake, request);
  return state;
}

// ---------------------------------------------------------------------------
// Discord side

export type DiscordPost = Readonly<{
  channelId: string;
  authorId: string;
  text: string;
  /** Mentions the bot user at the start, as Discord's client writes `@bot`. */
  mention?: boolean;
  replyTo?: string;
  attachments?: readonly Readonly<{ filename: string; data: Buffer; contentType: string }>[];
}>;

/** A person's message through the fake gateway. */
export function say(fake: FakeDiscord, post: DiscordPost): FakeDiscordMessage {
  return fake.postMessage({
    authorId: post.authorId, channelId: post.channelId,
    content: post.mention ? `<@${fake.bot.id}> ${post.text}` : post.text,
    ...(post.mention ? { mentions: [fake.bot.id] } : {}),
    ...(post.replyTo ? { replyTo: post.replyTo } : {}),
    ...(post.attachments ? { attachments: post.attachments } : {})
  });
}

/** A thread people opened from `starterId` in `parentId`, as a Discord client does (the thread takes the message's id). */
export async function openPeopleThread(fake: FakeDiscord, parentId: string, starterId: string, name: string): Promise<string> {
  const response = await fake.handle(new Request(`http://127.0.0.1/api/v10/channels/${parentId}/messages/${starterId}/threads`, {
    body: JSON.stringify({ name }), headers: { authorization: `Bot ${fake.token}`, "content-type": "application/json" }, method: "POST"
  }));
  expect(response.status, "the fake opens the people's thread").toBe(201);
  return starterId;
}

export function botReacted(fake: FakeDiscord, messageId: string, emoji: string): boolean {
  return fake.reactions(messageId, emoji).includes(fake.bot.id);
}

/** The bot's messages in a channel, oldest first. */
export function botMessages(fake: FakeDiscord, channelId: string): FakeDiscordMessage[] {
  return fake.messages(channelId).filter((message) => message.author.id === fake.bot.id);
}

/** What the bot did since call `since`: REST routes and statuses only. */
export function botActivity(fake: FakeDiscord, since = 0): string {
  return fake.calls().slice(since).filter((call) => call.route !== "get_gateway_bot")
    .map((call) => `${call.method} ${call.route} ${call.status}`).join(", ") || "nothing";
}

// ---------------------------------------------------------------------------
// The journal

export type DiscordReplyView = Readonly<{
  state: string;
  kind: string;
  code: string | null;
  limitKind: string | null;
  test: boolean;
  runId: string | null;
  chatId: string | null;
  conversationKind: string | null;
  /** Where the answer (or the refusal note) is: the conversation's channel, else the question's. */
  answerChannelId: string;
  answerMessageId: string | null;
  statusMessageId: string | null;
  sources: number | null;
  subagents: number | null;
}>;

export async function discordReply(prisma: PrismaClient, questionId: string): Promise<DiscordReplyView | null> {
  const row = await prisma.discordReply.findUnique({
    include: { conversation: { select: { chatId: true, discordChannelId: true, kind: true } } },
    where: { questionMessageId: BigInt(questionId) }
  });
  if (!row) return null;
  return {
    answerChannelId: String(row.conversation?.discordChannelId ?? row.channelId),
    answerMessageId: row.answerMessageId === null ? null : String(row.answerMessageId),
    chatId: row.conversation?.chatId ?? null,
    code: row.code,
    conversationKind: row.conversation?.kind ?? null,
    kind: row.kind,
    limitKind: row.limitKind,
    runId: row.runId,
    sources: row.sources,
    state: row.state,
    statusMessageId: row.statusMessageId === null ? null : String(row.statusMessageId),
    subagents: row.subagents,
    test: row.test
  };
}

/** Waits for the question's row to reach one of `states` (settled by default). */
export async function waitForDiscordReply(
  prisma: PrismaClient, fake: FakeDiscord, questionId: string,
  options: Readonly<{ states?: readonly string[]; since?: number; timeout?: number }> = {}
): Promise<DiscordReplyView> {
  const states: readonly string[] = options.states ?? SETTLED_STATES;
  const seen: { row: DiscordReplyView | null } = { row: null };
  try {
    await expect.poll(async () => {
      seen.row = await discordReply(prisma, questionId);
      return seen.row !== null && states.includes(seen.row.state);
    }, { timeout: options.timeout ?? DISCORD_REPLY_TIMEOUT_MS }).toBe(true);
  } catch (error) {
    const row = seen.row;
    throw new Error(`question not ${states.join("/")}: ${row ? `${row.state} ${row.code ?? ""}` : "no journal row"}; ` +
      `the bot did: ${botActivity(fake, options.since)}`, { cause: error });
  }
  return seen.row!;
}

/** The delivered answer message the row names. */
export function answerMessage(fake: FakeDiscord, reply: DiscordReplyView): FakeDiscordMessage {
  const found = fake.messages(reply.answerChannelId).find((message) => message.id === reply.answerMessageId);
  expect(found, "the answer message is in its channel").toBeTruthy();
  return found!;
}

/** Waits until the bot's reaction `emoji` is on the message. */
export async function waitForReaction(fake: FakeDiscord, messageId: string, emoji: string, timeout = DISCORD_REPLY_TIMEOUT_MS): Promise<void> {
  await expect.poll(() => botReacted(fake, messageId, emoji), { message: `the bot reacts ${emoji}`, timeout }).toBe(true);
}

/** The text of the chat's user turns (what the run was given), oldest first. */
export async function chatUserText(prisma: PrismaClient, chatId: string): Promise<string> {
  const messages = await prisma.message.findMany({ orderBy: { createdAt: "asc" }, select: { content: true }, where: { chatId, role: "user" } });
  return messages.map((message) => {
    const blocks = (message.content as { blocks?: Array<{ type?: string; text?: string }> } | null)?.blocks ?? [];
    return blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
  }).join("\n\n");
}

/** Image blocks among the chat's user turns. */
export async function chatUserImageCount(prisma: PrismaClient, chatId: string): Promise<number> {
  const messages = await prisma.message.findMany({ select: { content: true }, where: { chatId, role: "user" } });
  return messages.reduce((sum, message) =>
    sum + ((message.content as { blocks?: Array<{ type?: string }> } | null)?.blocks ?? []).filter((block) => block.type === "image").length, 0);
}
