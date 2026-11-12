import { deflateSync } from "node:zlib";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import type { FakeDiscordMessage } from "../support/fakeDiscord";
import { createAssistantFixture } from "./support/assistants";
import {
  answerMessage, chatUserImageCount, configureDiscordByApi, disableDiscord, say, startDiscordStand, waitForDiscordReply, waitForReaction,
  type DiscordReplyView, type DiscordStand
} from "./support/discordStand";
import {
  connectionSearchSource, PAID_SETUP_TIMEOUT_MS, PAID_TURN_TIMEOUT_MS, paidEnv, setupCodexLbAnswerModel, type PaidAnswerModel
} from "./support/paidProviders";
import { createPeopleFixture, type E2ESession } from "./support/people";

/**
 * Opt-in paid Discord Connect checks (PRD §12.4): the fake Discord gateway
 * and REST on the stand's loopback ports, with a REAL codex-lb answer model
 * behind the Discord Assistant and its hosted web Search on. Three questions:
 * one that needs a web search and must cite sources as Discord masked links,
 * one that has the model call a foreground sub-agent, and a Reply to a
 * message carrying an image that the model must describe.
 *
 * Runs only with AIQSA_FEATURES_PAID_E2E=DISPOSABLE, CODEX_LB_API_KEY and
 * CODEX_LB_BASE_URL on a disposable test-mode stand (the fake Discord's
 * origins are honoured only in test mode). The key goes only to the stand's
 * admin API. Assertions and annotations carry states, codes, booleans and
 * counts; answers, prompts and keys are never printed, and traces,
 * screenshots and videos stay off. The codex-lb connection stays on the
 * disposable stand.
 */

const paid = process.env.AIQSA_FEATURES_PAID_E2E === "DISPOSABLE" && paidEnv("CODEX_LB_API_KEY") !== null &&
  paidEnv("CODEX_LB_BASE_URL") !== null;

test.describe.configure({ mode: "serial", timeout: PAID_TURN_TIMEOUT_MS + 60_000 });
test.use({ screenshot: "off", trace: "off", video: "off" });
test.skip(!paid, "paid Discord check is opt-in: AIQSA_FEATURES_PAID_E2E=DISPOSABLE, CODEX_LB_API_KEY and CODEX_LB_BASE_URL");

const prisma = new PrismaClient();
const people = createPeopleFixture(prisma);
const assistants = createAssistantFixture(prisma, { suffix: people.suffix });

let stand: DiscordStand;
let adminSession: E2ESession;
let model: PaidAnswerModel;
let alice: string;
let bob: string;

/** A solid-colour PNG, so the expected description is one word. */
function solidPng(width: number, height: number, rgb: readonly [number, number, number]): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = table[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))
  ]);
}

async function answered(question: FakeDiscordMessage, since: number): Promise<DiscordReplyView> {
  const reply = await waitForDiscordReply(prisma, stand.fake, question.id, { since, timeout: PAID_TURN_TIMEOUT_MS });
  expect(reply.state, `answer state (${reply.code ?? "no code"})`).toBe("delivered");
  await waitForReaction(stand.fake, question.id, "✅");
  return reply;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(PAID_SETUP_TIMEOUT_MS + 120_000);
  stand = await startDiscordStand(["dc-live"]);
  alice = stand.fake.addUser({ globalName: "Alice", username: `alice_${people.suffix}` });
  bob = stand.fake.addUser({ globalName: "Bob", username: `bob_${people.suffix}` });
  adminSession = await people.signIn(browser, (await people.admin("Discord live admin"))!);
  const request = adminSession.page.request;
  await disableDiscord(request);
  model = await setupCodexLbAnswerModel(request, { label: "Discord live", nativeSearch: true, vision: true });
  const search = await connectionSearchSource(request, model.connectionId, "web_search", { protocol: "openai_responses_web_search" });
  const assistant = await assistants.create(request, {
    name: "Discord live agent",
    rows: {
      model: { policy: "fixed", value: { mode: "model", modelId: model.modelId } },
      search: { policy: "fixed", value: { mode: "model_choice", optionIds: [search.strategyId] } }
    },
    systemPrompt: "You answer questions asked in a Discord server. Keep answers short."
  });
  await assistants.publish(request, assistant.id, "installation");
  await configureDiscordByApi(request, prisma, stand.fake, { assistantId: assistant.id, channelIds: [stand.channels["dc-live"]!] });
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

test("a question that needs the web is answered with cited sources as Discord masked links", async () => {
  const { fake } = stand;
  const since = fake.calls().length;
  const question = say(fake, {
    authorId: alice, channelId: stand.channels["dc-live"]!, mention: true,
    text: "What is the latest stable version of the Unity Editor? Search the web exactly once and cite your sources."
  });
  const reply = await answered(question, since);
  const answer = answerMessage(fake, reply);
  const citations = answer.content.match(/\[\d+\]\(<https?:\/\/[^>\s]+>\)/gu)?.length ?? 0;
  test.info().annotations.push({ description: `sources ${reply.sources ?? "null"}, masked links ${citations}`, type: "search" });
  expect(reply.sources ?? 0, "the journal counts the cited sources").toBeGreaterThan(0);
  expect(citations, "the answer cites with [N](<url>) links").toBeGreaterThan(0);
  expect(answer.content.length).toBeLessThanOrEqual(2_000);
});

test("a question that asks for a sub-agent runs a foreground sub-agent inside the Discord run", async () => {
  const { fake } = stand;
  const since = fake.calls().length;
  const question = say(fake, {
    authorId: bob, channelId: stand.channels["dc-live"]!, mention: true,
    text: "Use exactly one sub-agent (call_subagent, not in the background) to compute 17 multiplied by 23, then reply with its result only."
  });
  const reply = await answered(question, since);
  const answer = answerMessage(fake, reply);
  test.info().annotations.push({ description: `sub-agents ${reply.subagents ?? "null"}`, type: "subagent" });
  expect(reply.subagents ?? 0, "the journal counts the sub-agent").toBeGreaterThan(0);
  expect(answer.content.includes("391"), "the answer carries the sub-agent's result").toBe(true);
});

test("a Reply to a message with an image gives the model that image", async () => {
  const { fake } = stand;
  const channel = stand.channels["dc-live"]!;
  const picture = say(fake, {
    attachments: [{ contentType: "image/png", data: solidPng(64, 64, [220, 20, 20]), filename: "square.png" }],
    authorId: bob, channelId: channel, text: "Here is the picture."
  });
  const since = fake.calls().length;
  const question = say(fake, {
    authorId: alice, channelId: channel, mention: true, replyTo: picture.id,
    text: "What single colour fills the image in the message I am replying to? Answer with one English word."
  });
  const reply = await answered(question, since);
  const answer = answerMessage(fake, reply);
  const images = await chatUserImageCount(prisma, reply.chatId!);
  test.info().annotations.push({ description: `image blocks ${images}`, type: "image" });
  expect(images, "the reference's image reached the run").toBeGreaterThan(0);
  expect(/\bred\b/iu.test(answer.content), "the model describes the image's colour").toBe(true);
});
