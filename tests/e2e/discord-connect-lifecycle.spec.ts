import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { DISCORD_LIMIT_DEFAULTS, type DiscordMonitoringKeyList } from "../../lib/contracts/discord";
import type { FakeDiscordMessage } from "../support/fakeDiscord";
import { createAssistantFixture } from "./support/assistants";
import {
  answerMessage, botActivity, configureDiscordByApi, discordActivity, discordCommand, discordReply, discordState, disableDiscord, say,
  startDiscordStand, waitForDiscordReply, waitForAnsweredReactions, waitForReaction, type DiscordReplyView, type DiscordStand
} from "./support/discordStand";
import { createPeopleFixture, type E2ESession } from "./support/people";

/**
 * Discord Connect after the answer (PRD §4 scenarios 10–14, D-27, D-29,
 * D-34) on the fake Discord and the deterministic fake model: a follow-up
 * joins a running answer, deleting a question removes its answer or stops its
 * run, 👍/👎 are recorded and counted in Activity, the per-author limit
 * refuses with its note, the monitoring endpoints take a key and refuse a
 * revoked one, and Disable silences the bot. The setup goes through the admin
 * API here; `discord-connect.spec.ts` covers it through the UI. A run is held
 * open with the fake provider's test-only `silent` directive.
 */

test.describe.configure({ mode: "serial", timeout: 120_000 });

const ACTIVE_RUN_STATUSES = ["preparing", "queued", "streaming", "in_progress"];
const prisma = new PrismaClient();
const people = createPeopleFixture(prisma);
const assistants = createAssistantFixture(prisma, { suffix: people.suffix });
const marker = (label: string) => `${label}-${people.suffix}-${randomBytes(3).toString("hex")}`;
/** Holds the run's first model request for `ms`; the id is unique per stand process and run. */
const hold = (label: string, ms: number) => `[AIQSA_PROVIDER_WAIT_E2E:${label}-${people.suffix}-${randomBytes(3).toString("hex")}:silent${ms}]`;

let stand: DiscordStand;
let adminSession: E2ESession;
let alice: string;
let bob: string;
let carol: string;
let dana: string;
let erin: string;

async function openDiscordSection(page: Page): Promise<void> {
  await page.goto("/admin?section=discord");
  await expect(page.getByTestId("discord-bot-state")).toBeVisible({ timeout: 30_000 });
}

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

/** Waits until the question's run is admitted and its Working status is posted. */
async function running(question: FakeDiscordMessage, since: number): Promise<DiscordReplyView> {
  await waitForDiscordReply(prisma, stand.fake, question.id, { since, states: ["admitted"] });
  const seen: { row: DiscordReplyView | null } = { row: null };
  await expect.poll(async () => (seen.row = await discordReply(prisma, question.id))?.statusMessageId ?? null, {
    message: "the Working status is posted", timeout: 30_000
  }).not.toBeNull();
  return seen.row!;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  stand = await startDiscordStand(["dc-followup", "dc-delete", "dc-ratings", "dc-limit"]);
  const { fake } = stand;
  alice = fake.addUser({ globalName: "Alice", username: `alice_${people.suffix}` });
  bob = fake.addUser({ globalName: "Bob", username: `bob_${people.suffix}` });
  carol = fake.addUser({ globalName: "Carol", username: `carol_${people.suffix}` });
  dana = fake.addUser({ globalName: "Dana", username: `dana_${people.suffix}` });
  erin = fake.addUser({ globalName: "Erin", username: `erin_${people.suffix}` });
  adminSession = await people.signIn(browser, (await people.admin("Discord lifecycle admin"))!);
  const request = adminSession.page.request;
  const assistant = await assistants.create(request, { name: "Discord lifecycle agent" });
  await assistants.publish(request, assistant.id, "installation");
  await configureDiscordByApi(request, prisma, fake, {
    assistantId: assistant.id, callNames: ["Agent"], channelIds: [fake.channels.text, ...Object.values(stand.channels)]
  });
});

test.afterAll(async () => {
  try {
    if (adminSession) {
      const request = adminSession.page.request;
      await disableDiscord(request);
      await discordCommand(request, { action: "set_limits", limits: { ...DISCORD_LIMIT_DEFAULTS } });
    }
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

test("a call-name message in the thread while the answer runs joins that run: 👀, taken back on both with the answer", async () => {
  const { fake } = stand;
  const since = fake.calls().length;
  const question = say(fake, {
    authorId: alice, channelId: stand.channels["dc-followup"]!, mention: true, text: `How is the migration going? ${hold("dcfu", 8_000)}`
  });
  const main = await running(question, since);
  await afterMergeWindow(question);
  const followUp = say(fake, { authorId: alice, channelId: question.id, text: `Agent, and consider ${marker("constraint")}.` });
  await waitForReaction(fake, followUp.id, "👀", 30_000);

  await delivered(question, since);
  const joined = await waitForDiscordReply(prisma, fake, followUp.id, { since });
  expect(joined.kind).toBe("follow_up");
  expect(joined.state).toBe("delivered");
  expect(joined.runId).toBe(main.runId);
  await waitForAnsweredReactions(fake, followUp.id);
  expect(fake.violations()).toEqual([]);
});

test("deleting a question removes its answer, and deleting one mid-run stops the run and removes the status", async () => {
  const { fake } = stand;
  const channel = stand.channels["dc-delete"]!;
  let since = fake.calls().length;
  const answered = say(fake, { authorId: bob, channelId: channel, mention: true, text: `Short question ${marker("gone")}` });
  const reply = await delivered(answered, since);
  answerMessage(fake, reply);
  fake.deleteMessage(channel, answered.id);
  await expect.poll(() => fake.messages(reply.answerChannelId).some((message) => message.id === reply.answerMessageId), {
    message: "the answer is deleted with its question", timeout: 30_000
  }).toBe(false);
  expect((await discordReply(prisma, answered.id))?.state, "a delivered answer keeps its outcome").toBe("delivered");

  await afterMergeWindow(answered);
  since = fake.calls().length;
  const midRun = say(fake, { authorId: bob, channelId: channel, mention: true, text: `Long question ${hold("dcdel", 20_000)}` });
  const runningReply = await running(midRun, since);
  fake.deleteMessage(channel, midRun.id);
  const stopped = await waitForDiscordReply(prisma, fake, midRun.id, { since, states: ["interrupted"] });
  expect(stopped.code).toBe("discord_question_deleted");
  await expect.poll(() => fake.messages(runningReply.answerChannelId).some((message) => message.id === runningReply.statusMessageId), {
    message: "the Working status is deleted", timeout: 30_000
  }).toBe(false);
  await expect.poll(async () => {
    const run = await prisma.modelRun.findUnique({ select: { status: true }, where: { id: runningReply.runId! } });
    return run !== null && !ACTIVE_RUN_STATUSES.includes(run.status);
  }, { message: "the run is stopped", timeout: 30_000 }).toBe(true);
});

test("👍 and 👎 on an answer are recorded, the first 👎 files one problem report, and Activity counts them", async () => {
  const { fake } = stand;
  const { page } = adminSession;
  const since = fake.calls().length;
  const question = say(fake, { authorId: alice, channelId: stand.channels["dc-ratings"]!, mention: true, text: `Rate me ${marker("rate")}` });
  const reply = await delivered(question, since);
  const answerId = reply.answerMessageId!;
  fake.react(bob, reply.answerChannelId, answerId, "👍");
  fake.react(carol, reply.answerChannelId, answerId, "👎");
  fake.react(dana, reply.answerChannelId, answerId, "👎");
  // Other emoji are no ratings.
  fake.react(erin, reply.answerChannelId, answerId, "🎉");

  await expect.poll(async () => (await prisma.discordAnswerRating.findMany({
    select: { value: true }, where: { replyId: BigInt(question.id) }
  })).map((rating) => rating.value).sort(), { timeout: 30_000 }).toEqual([-1, -1, 1]);
  await expect.poll(() => prisma.answerProblemReport.count({ where: { runId: reply.runId! } }), { timeout: 30_000 }).toBe(1);

  fake.unreact(carol, reply.answerChannelId, answerId, "👎");
  await expect.poll(async () => (await prisma.discordAnswerRating.findMany({
    select: { value: true }, where: { replyId: BigInt(question.id) }
  })).map((rating) => rating.value).sort(), { message: "a removed reaction removes its rating", timeout: 30_000 }).toEqual([-1, 1]);

  const activity = await discordActivity(page.request);
  expect(activity.last24h.ratingsUp).toBeGreaterThanOrEqual(1);
  expect(activity.last24h.ratingsDown).toBeGreaterThanOrEqual(1);
  expect(activity.rows.some((row) => row.questionMessageId === question.id && row.state === "delivered")).toBe(true);

  await openDiscordSection(page);
  const card = page.getByTestId("discord-activity");
  await card.getByRole("button", { name: "Refresh" }).click();
  const ratings = card.locator("dt", { hasText: "Ratings up / down" }).first().locator("xpath=following-sibling::dd[1]");
  await expect(ratings).toHaveText(/^[1-9]\d* \/ [1-9]\d*$/u);
  await expect(card.getByTestId("discord-activity-rows")).toBeVisible();
});

test("over the per-author limit set in Admin → Discord the question is refused with ❌ and the limit note", async () => {
  const { fake } = stand;
  const { page } = adminSession;
  await openDiscordSection(page);
  await page.getByTestId("discord-limit-perAuthorHourly").fill("1");
  await page.getByTestId("discord-save-limits").click();
  await expect.poll(async () => (await discordState(page.request)).limits.perAuthorHourly).toBe(1);
  try {
    const channel = stand.channels["dc-limit"]!;
    let since = fake.calls().length;
    const first = say(fake, { authorId: erin, channelId: channel, mention: true, text: `First ${marker("limit")}` });
    await delivered(first, since);

    await afterMergeWindow(first);
    since = fake.calls().length;
    const second = say(fake, { authorId: erin, channelId: channel, mention: true, text: `Second ${marker("limit")}` });
    const refused = await waitForDiscordReply(prisma, fake, second.id, { since });
    expect(refused.state).toBe("failed");
    expect(refused.kind).toBe("refused");
    expect(refused.code).toBe("discord_user_limit");
    expect(refused.limitKind).toBe("author");
    await waitForReaction(fake, second.id, "❌");
    const note = answerMessage(fake, refused);
    expect(note.message_reference?.message_id).toBe(second.id);
    expect(note.content).toMatch(/^❌ You've reached the limit of 1 questions per hour\. Try again in \d+ min\.$/u);
    expect(fake.channel(second.id), "a refused question opens no thread").toBeUndefined();
  } finally {
    await discordCommand(page.request, { action: "set_limits", limits: { ...DISCORD_LIMIT_DEFAULTS } });
  }
});

test("a monitoring key created in Admin → Discord reads the metrics and the JSON, and a revoked or missing key gets 404", async ({ baseURL, playwright }) => {
  const { page } = adminSession;
  const keys = async () => (await (await page.request.get("/api/admin/discord/monitoring-keys")).json()) as DiscordMonitoringKeyList;
  const before = new Set((await keys()).keys.map((key) => key.id));
  await openDiscordSection(page);
  await page.getByTestId("discord-create-key").click();
  const secret = await page.getByTestId("discord-key-secret").inputValue();
  expect(secret).toMatch(/^aiqsa_dmk_/u);
  await page.getByTestId("discord-key-done").click();
  const created = (await keys()).keys.find((key) => !before.has(key.id));
  expect(created, "the new key is listed without its secret").toBeTruthy();

  const monitor = await playwright.request.newContext({ baseURL });
  try {
    const bearer = { authorization: `Bearer ${secret}` };
    const metrics = await monitor.get("/api/monitoring/discord/metrics", { headers: bearer });
    expect(metrics.status()).toBe(200);
    const text = await metrics.text();
    expect(text).toMatch(/^aiqsa_discord_enabled 1$/mu);
    expect(text).toMatch(/^aiqsa_discord_gateway_connected 1$/mu);
    expect(text).toMatch(/^aiqsa_discord_requests_1h\{test="false"\} [1-9]\d*$/mu);
    expect(text.includes(people.suffix), "metrics carry no names").toBe(false);
    const telemetry = await monitor.get("/api/monitoring/discord", { headers: bearer });
    expect(telemetry.status()).toBe(200);
    expect((await telemetry.text()).includes(people.suffix), "the JSON carries no names or text").toBe(false);

    expect((await monitor.get("/api/monitoring/discord/metrics")).status()).toBe(404);
    expect((await monitor.get("/api/monitoring/discord/metrics", { headers: { authorization: `Bearer ${secret}x` } })).status()).toBe(404);

    const revoked = await page.request.delete(`/api/admin/discord/monitoring-keys/${created!.id}`);
    expect(revoked.status()).toBe(200);
    expect((await monitor.get("/api/monitoring/discord/metrics", { headers: bearer })).status()).toBe(404);
    expect((await monitor.get("/api/monitoring/discord", { headers: bearer })).status()).toBe(404);
  } finally {
    await monitor.dispose();
  }
});

test("Disable in Admin → Discord closes the session and the bot stays silent", async () => {
  const { fake } = stand;
  const { page } = adminSession;
  await openDiscordSection(page);
  await page.getByTestId("discord-disable").click();
  await expect(page.getByTestId("discord-bot-status")).toHaveText("Off");
  await expect.poll(() => fake.gateway.connections().some((connection) => connection.ready), {
    message: "the gateway session closes", timeout: 15_000
  }).toBe(false);

  const since = fake.calls().length;
  const question = say(fake, { authorId: alice, channelId: fake.channels.text, mention: true, text: `Anyone there? ${marker("off")}` });
  // A negative check needs a wait: long enough for an enabled bot to have reacted (it does within a second on this stand).
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  expect(await discordReply(prisma, question.id)).toBeNull();
  expect(fake.reactions(question.id, "👀")).toEqual([]);
  const sent = fake.calls().slice(since).filter((call) => call.method !== "GET");
  expect(sent.length, `nothing is sent to Discord (${botActivity(fake, since)})`).toBe(0);
});
