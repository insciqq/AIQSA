import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { DISCORD_COPY } from "../../lib/server/discord/copy";
import { FAKE_DISCORD_CHANNEL_TYPES, type FakeDiscordMessage } from "../support/fakeDiscord";
import { createAssistantFixture } from "./support/assistants";
import {
  answerMessage, botMessages, chatUserText, discordCommand, discordReply, discordState, disableDiscord, grantServiceAccountFullAccess, openPeopleThread,
  say, startDiscordStand, waitForDiscordReply, waitForGateway, waitForAnsweredReactions, type DiscordReplyView, type DiscordStand
} from "./support/discordStand";
import { createPeopleFixture, type E2ESession } from "./support/people";

/**
 * Discord Connect end to end on the fake Discord (PRD §4, §12.4): the
 * administrator sets the bot up through Admin → Discord, then people talk to
 * it through the fake gateway while the real intake, bridge, run gateway and
 * the deterministic fake model answer. Each scenario checks what reached
 * Discord (messages, threads, reactions) and what the journal and the chat
 * recorded. No provider is called. Follow-ups, deletes, ratings, limits,
 * monitoring and the kill switch are in `discord-connect-lifecycle.spec.ts`.
 */

test.describe.configure({ mode: "serial", timeout: 120_000 });

const prisma = new PrismaClient();
const people = createPeopleFixture(prisma);
const assistants = createAssistantFixture(prisma, { suffix: people.suffix });
const marker = (label: string) => `${label}-${people.suffix}-${randomBytes(3).toString("hex")}`;

let stand: DiscordStand;
let adminSession: E2ESession;
let alice: string;
let bob: string;
let carol: string;
let dana: string;
/** The thread the bot opened in the first conversation scenario, for the chatter that follows. */
let botThread: { id: string; question: FakeDiscordMessage; chatId: string } | null = null;

async function openDiscordSection(page: Page): Promise<void> {
  await page.goto("/admin?section=discord");
  await expect(page.getByTestId("discord-bot-state")).toBeVisible({ timeout: 30_000 });
}

/** Waits past Discord's 1.5 s window in which one author's messages join one question. */
async function afterMergeWindow(previous: FakeDiscordMessage): Promise<void> {
  const wait = Date.parse(previous.timestamp) + 2_000 - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

async function delivered(question: FakeDiscordMessage, since: number): Promise<DiscordReplyView> {
  const reply = await waitForDiscordReply(prisma, stand.fake, question.id, { since });
  expect(reply.state, `answer state (${reply.code ?? "no code"})`).toBe("delivered");
  await waitForAnsweredReactions(stand.fake, question.id);
  return reply;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  stand = await startDiscordStand(["dc-threads", "dc-cards", "dc-long"]);
  const { fake } = stand;
  alice = fake.addUser({ globalName: "Alice", username: `alice_${people.suffix}` });
  bob = fake.addUser({ globalName: "Bob", username: `bob_${people.suffix}` });
  carol = fake.addUser({ globalName: "Carol", username: `carol_${people.suffix}` });
  dana = fake.addUser({ globalName: "Dana", username: `dana_${people.suffix}` });
  adminSession = await people.signIn(browser, (await people.admin("Discord admin"))!);
  // A previous run on a reused stand may have left the singleton bot on, and call names saved.
  await disableDiscord(adminSession.page.request);
  await discordCommand(adminSession.page.request, { action: "set_call_names", callNames: [] });
});

test.afterAll(async () => {
  try {
    if (adminSession) await disableDiscord(adminSession.page.request);
  } finally {
    try {
      await assistants.cleanup();
      await people.cleanup();
    } finally {
      await stand?.stop();
      await prisma.$disconnect();
    }
  }
});

test("an administrator sets the bot up in Admin → Discord: token, server, channels, service account, Assistant, Setup, Enable and Disable", async () => {
  test.setTimeout(180_000);
  const { fake } = stand;
  const { page } = adminSession;
  const request = page.request;
  await openDiscordSection(page);

  await page.getByTestId("discord-token-input").fill(fake.token);
  await page.getByTestId("discord-test-and-save").click();
  const identity = page.getByTestId("discord-bot-identity");
  await expect(identity).toContainText(`@${fake.bot.username}`);
  await expect(identity).toContainText("Message Content: on");

  await expect(page.getByTestId("discord-guild-select").locator(`option[value="${fake.guild.id}"]`)).toHaveCount(1);
  await page.getByTestId("discord-guild-select").selectOption(fake.guild.id);
  await page.getByTestId("discord-save-guild").click();
  await expect(page.getByTestId("discord-bot-state")).toContainText(`in ${fake.guild.name}`);

  const channels = page.getByTestId("discord-channel-list");
  await expect(page.getByTestId("discord-channel-mode-only_listed")).toBeChecked();
  for (const name of ["agent-test", "dc-threads", "dc-cards", "dc-long"]) {
    await channels.getByRole("checkbox", { exact: true, name: `#${name}` }).check();
  }
  await channels.getByRole("checkbox", { name: /^#voice-room\b/u }).check();
  await page.getByTestId("discord-save-channels").click();
  await expect.poll(async () => (await discordState(request)).channels.map((channel) => channel.id).sort())
    .toEqual([fake.channels.text, fake.channels.voice, ...Object.values(stand.channels)].sort());
  await expect(page.getByTestId("discord-channels-form")).toContainText("The bot answers in 5 channels.");

  // The service account exists once per installation; a reused stand already has it.
  const create = page.getByTestId("discord-create-service-account");
  if ((await discordState(request)).serviceAccount.status === "missing") await create.click();
  await expect.poll(async () => (await discordState(request)).serviceAccount.status).toBe("active");
  await expect(page.getByTestId("discord-service-account")).toContainText("Active");
  // Without an Assistant the checklist blocks Enable and says what to do.
  const setup = page.getByTestId("discord-setup");
  await expect(setup.locator('[data-code="discord_assistant_missing"]')).toBeVisible();
  await expect(page.getByTestId("discord-setup-summary")).toHaveText(/blocks? Enable$/u);
  await expect(page.getByTestId("discord-enable")).toBeDisabled();

  // The administrator gives the account models (a group) and publishes an Assistant on the fake model.
  const serviceUserId = (await discordState(request)).serviceAccount.userId!;
  await grantServiceAccountFullAccess(request, prisma, serviceUserId);
  const assistant = await assistants.create(request, { name: "Discord agent", systemPrompt: "Answer Discord questions briefly." });
  await assistants.publish(request, assistant.id, "installation");
  await page.reload();
  await expect(page.getByTestId("discord-assistant-select").locator(`option[value="${assistant.id}"]`)).toHaveCount(1, { timeout: 15_000 });
  await page.getByTestId("discord-assistant-select").selectOption(assistant.id);
  await page.getByTestId("discord-save-assistant").click();
  await expect(page.getByTestId("discord-setup-summary")).toHaveText(/^Ready/u);
  // Passed checks fold under "N checks passed"; the Assistant check is one of them now.
  await expect(page.getByTestId("discord-setup-passed")).toContainText(/checks? passed/u);
  await expect(page.getByTestId("discord-setup-passed").locator('[data-code="discord_assistant_missing"]')).toHaveCount(1);

  await page.getByTestId("discord-enable").click();
  await expect(page.getByTestId("discord-disable")).toBeVisible();
  await waitForGateway(fake, request);
  await page.reload();
  await expect(page.getByTestId("discord-bot-status")).toHaveText("Connected", { timeout: 15_000 });

  await page.getByTestId("discord-disable").click();
  await expect(page.getByTestId("discord-bot-status")).toHaveText("Off");
  await expect.poll(() => fake.gateway.connections().some((connection) => connection.ready), { timeout: 15_000 }).toBe(false);
  await page.getByTestId("discord-enable").click();
  await waitForGateway(fake, request);
  await page.reload();
  await expect(page.getByTestId("discord-bot-status")).toHaveText("Connected", { timeout: 15_000 });
  expect(fake.violations()).toEqual([]);
});

test("a mention in a channel opens a thread, its Working status becomes the answer and the question's 👀 comes off", async () => {
  const { fake } = stand;
  const since = fake.calls().length;
  const topic = marker("release");
  const question = say(fake, { authorId: alice, channelId: fake.channels.text, mention: true, text: `What changed in ${topic}?` });
  const reply = await delivered(question, since);

  expect(reply.kind).toBe("answer");
  expect(reply.conversationKind).toBe("thread");
  // Discord gives a thread started from a message that message's id.
  const thread = fake.channel(question.id);
  expect(thread?.type).toBe(FAKE_DISCORD_CHANNEL_TYPES.publicThread);
  expect(thread?.parent_id).toBe(fake.channels.text);
  expect(reply.answerChannelId).toBe(question.id);

  const posts = fake.calls({ route: "create_message" }).filter((call) => call.path === `/channels/${question.id}/messages`);
  expect(posts.some((call) => /^Working · \d+:\d{2}/u.test(String((call.json as { content?: unknown } | undefined)?.content ?? ""))),
    "the status went out as Working · m:ss").toBe(true);
  expect(reply.answerMessageId).toBe(reply.statusMessageId);
  const answer = answerMessage(fake, reply);
  expect(answer.edited_timestamp, "the status message was edited into the answer").not.toBeNull();
  expect(answer.content).toContain("Fake answer:");
  expect(answer.content).toContain(topic);
  expect(fake.calls({ route: "add_own_reaction" }).some((call) => decodeURIComponent(call.path).includes(`/messages/${question.id}/reactions/👀`)),
    "👀 went on the question first").toBe(true);
  await expect.poll(() => fake.reactions(question.id, "👀").includes(fake.bot.id), { message: "👀 is taken back" }).toBe(false);
  expect(fake.violations()).toEqual([]);
  botThread = { chatId: reply.chatId!, id: question.id, question };
});

test("in the bot's thread only a call name, a mention or a Reply to the bot asks; plain talk is not answered and the next answer reads it", async () => {
  test.skip(!botThread, "needs the bot's thread from the previous scenario");
  const { fake } = stand;
  const { page } = adminSession;
  const thread = botThread!;
  // The administrator gives the bot call names (synthetic ones; an installation chooses its own).
  await openDiscordSection(page);
  await page.getByTestId("discord-call-names").fill("Agent, Агент");
  await page.getByTestId("discord-save-call-names").click();
  await expect.poll(async () => (await discordState(page.request)).callNames).toEqual(["Agent", "Агент"]);
  await expect(page.getByTestId("discord-call-names")).toHaveValue("Agent\nАгент");

  const plainTopic = marker("rollout");
  const plain = say(fake, { authorId: bob, channelId: thread.id, text: `Is ${plainTopic} on track?` });
  const aside = marker("aside");
  const ping = marker("ping");
  const replyToBob = say(fake, { authorId: carol, channelId: thread.id, replyTo: plain.id, text: `Bob, ${aside} is mine.` });
  const pingDana = fake.postMessage({ authorId: carol, channelId: thread.id, content: `<@${dana}> have a look at ${ping}`, mentions: [dana] });
  // A word that only starts with a call name asks nothing either.
  const lookalike = say(fake, { authorId: dana, channelId: thread.id, text: `Agents of ${marker("other")} met today.` });
  let since = fake.calls().length;
  const deadline = marker("deadline");
  // Lanes keep one thread's messages in order, so once this question is answered the ones before it were seen.
  const aliceQuestion = say(fake, { authorId: alice, channelId: thread.id, text: `agent: and the ${deadline}?` });
  const aliceReply = await delivered(aliceQuestion, since);

  for (const ignored of [plain, replyToBob, pingDana, lookalike]) {
    expect(await discordReply(prisma, ignored.id), "a message that does not ask the bot is not claimed").toBeNull();
    expect(fake.reactions(ignored.id, "👀")).toEqual([]);
  }
  expect(aliceReply.chatId).toBe(thread.chatId);
  let context = await chatUserText(prisma, thread.chatId);
  for (const text of [plainTopic, aside, ping, `and the ${deadline}?`]) expect(context).toContain(text);
  // The call name and its delimiter are not part of the question.
  expect(context).not.toContain(`agent: and the ${deadline}`);

  // A Reply to the bot's answer asks as before, without a call name.
  await afterMergeWindow(aliceQuestion);
  since = fake.calls().length;
  const shorter = marker("shorter");
  const replyToBot = say(fake, { authorId: dana, channelId: thread.id, replyTo: aliceReply.answerMessageId!, text: `Shorter, ${shorter}?` });
  const replyAnswer = await delivered(replyToBot, since);
  expect(replyAnswer.chatId).toBe(thread.chatId);
  context = await chatUserText(prisma, thread.chatId);
  expect(context).toContain(shorter);
});

test("a mention in a thread people started reads the whole thread and answers there as a Reply", async () => {
  const { fake } = stand;
  const parent = stand.channels["dc-threads"]!;
  const starterTopic = marker("starter");
  const starter = say(fake, { authorId: alice, channelId: parent, text: `Plan for ${starterTopic}` });
  const threadId = await openPeopleThread(fake, parent, starter.id, "Plan");
  const earlier = [marker("one"), marker("two"), marker("three")];
  say(fake, { authorId: bob, channelId: threadId, text: `First note ${earlier[0]}` });
  say(fake, { authorId: carol, channelId: threadId, text: `Second note ${earlier[1]}` });
  say(fake, { authorId: bob, channelId: threadId, text: `Third note ${earlier[2]}` });
  const since = fake.calls().length;
  const question = say(fake, { authorId: dana, channelId: threadId, mention: true, text: "Summarize this thread." });
  const reply = await delivered(question, since);

  expect(reply.conversationKind).toBe("thread");
  expect(reply.answerChannelId).toBe(threadId);
  expect(answerMessage(fake, reply).message_reference?.message_id, "the answer is a Reply to the question").toBe(question.id);
  const context = await chatUserText(prisma, reply.chatId!);
  for (const text of [starterTopic, ...earlier]) expect(context).toContain(text);
});

test("a mention in a voice channel's chat is answered there as a Reply, and the next one continues the same chat", async () => {
  const { fake } = stand;
  const voice = fake.channels.voice;
  let since = fake.calls().length;
  const first = say(fake, { authorId: alice, channelId: voice, mention: true, text: `Agenda ${marker("voice")}?` });
  const firstReply = await delivered(first, since);
  expect(firstReply.conversationKind).toBe("voice_chat");
  expect(firstReply.answerChannelId).toBe(voice);
  expect(fake.channel(first.id), "no thread in a voice channel").toBeUndefined();
  expect(answerMessage(fake, firstReply).message_reference?.message_id).toBe(first.id);

  await afterMergeWindow(first);
  since = fake.calls().length;
  const second = say(fake, { authorId: bob, channelId: voice, mention: true, text: `And ${marker("next")}?` });
  const secondReply = await delivered(second, since);
  expect(secondReply.chatId).toBe(firstReply.chatId);
  expect(answerMessage(fake, secondReply).message_reference?.message_id).toBe(second.id);
});

test("a direct message, once the administrator turns them on, is answered in the DM and the conversation stays one chat", async () => {
  const { fake } = stand;
  const { page } = adminSession;
  await openDiscordSection(page);
  const toggle = page.getByTestId("discord-dm-switch");
  if (!(await discordState(page.request)).dmEnabled) await toggle.click();
  await expect.poll(async () => (await discordState(page.request)).dmEnabled).toBe(true);

  const dm = fake.openDm(dana);
  let since = fake.calls().length;
  const first = say(fake, { authorId: dana, channelId: dm, text: `Private question ${marker("dm")}` });
  const firstReply = await delivered(first, since);
  expect(firstReply.conversationKind).toBe("dm");
  expect(firstReply.answerChannelId).toBe(dm);
  expect(botMessages(fake, dm).map((message) => message.id)).toContain(firstReply.answerMessageId);

  await afterMergeWindow(first);
  since = fake.calls().length;
  const second = say(fake, { authorId: dana, channelId: dm, text: `Follow-up ${marker("dm2")}` });
  const secondReply = await delivered(second, since);
  expect(secondReply.chatId).toBe(firstReply.chatId);
});

test("a Reply to a post by the bot user is answered with that post in the context", async () => {
  const { fake } = stand;
  const channel = stand.channels["dc-cards"]!;
  const cardTopic = marker("card");
  // The other service on the same application posts as the bot user; AIQSA never sees such a post as its own answer.
  const card = fake.postMessage({ authorId: fake.bot.id, channelId: channel, content: `Decisions: item 3 is ${cardTopic}.` });
  const since = fake.calls().length;
  const question = say(fake, { authorId: carol, channelId: channel, replyTo: card.id, text: "What did we decide on item 3?" });
  const reply = await delivered(question, since);
  expect(await chatUserText(prisma, reply.chatId!)).toContain(cardTopic);
});

test("a long answer is cut with an Open in AIQSA link to a share page that shows the answer without the recognized secret", async ({ browser }) => {
  const { fake } = stand;
  const channel = stand.channels["dc-long"]!;
  const topic = marker("report");
  // Synthetic, but shaped like a credential the redaction recognizes (a secret-named key).
  const secret = `Zq${randomBytes(12).toString("hex")}Vx`;
  const head = `Long report ${topic}. Config line: DB_PASSWORD=${secret} . `;
  const text = `${head}${"Synthetic filler sentence for a long answer. ".repeat(60)}`.slice(0, 1_990 - fake.bot.id.length);
  const since = fake.calls().length;
  const question = say(fake, { authorId: alice, channelId: channel, mention: true, text });
  const reply = await delivered(question, since);

  const answer = answerMessage(fake, reply);
  expect(answer.content.length).toBeLessThanOrEqual(2_000);
  expect(answer.content.includes(secret), "the Discord answer carries no secret").toBe(false);
  const button = (answer.components as Array<{ components?: Array<{ label?: string; url?: string }> }>)
    .flatMap((row) => row.components ?? []).find((entry) => entry.label === DISCORD_COPY.openInAiqsa);
  // A link button needs an https AIQSA address; the stand's http one gets the link as a line instead.
  const line = new RegExp(`${DISCORD_COPY.openInAiqsa}: <(\\S+)>`, "u").exec(answer.content)?.[1];
  const shareUrl = button?.url ?? line;
  expect(shareUrl, "the cut answer links its share page").toBeTruthy();
  expect(new URL(shareUrl!).pathname).toMatch(/^\/s\/[^/]+$/u);

  const visitor = await browser.newContext({ locale: "en-US", reducedMotion: "reduce" });
  try {
    const page = await visitor.newPage();
    await page.goto(shareUrl!);
    await expect(page.getByText(topic).first()).toBeVisible({ timeout: 30_000 });
    expect((await page.content()).includes(secret), "the share page carries no secret").toBe(false);
  } finally {
    await visitor.close();
  }
});
