import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { PrismaClient } from "@prisma/client";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { decodeAdminSpeechToTextResponse, DICTATION_AUDIO_MAX_BYTES, type AdminSpeechToTextRole } from "../../lib/contracts/speechToText";
import { readConnections } from "../../scripts/context-compaction-journey-support";
import type { FakeDiscordMessage } from "../support/fakeDiscord";
import { createAssistantFixture } from "./support/assistants";
import {
  answerMessage, chatUserText, configureDiscordByApi, disableDiscord, say, sayVoice, startDiscordStand, waitForAnsweredReactions,
  waitForDiscordReply, type DiscordReplyView, type DiscordStand
} from "./support/discordStand";
import {
  openRouterConnection, PAID_SETUP_TIMEOUT_MS, PAID_TURN_TIMEOUT_MS, paidEnv, pollUntil, setupCodexLbAnswerModel,
  type PaidAnswerModel
} from "./support/paidProviders";
import { createPeopleFixture, type E2ESession } from "./support/people";

/**
 * Opt-in paid check of Discord voice messages (operator decision 2026-11-16):
 * the fake Discord gateway, REST and CDN on the stand's loopback ports, a REAL
 * codex-lb answer model behind the Discord Assistant, and a REAL OpenRouter
 * Whisper Speech to text role. Two questions, each one paid transcription:
 *
 * 1. a voice message in a direct message is answered from what it says;
 * 2. a mention in a Reply to someone else's voice message asks the agent
 *    about what that voice message says.
 *
 * The fixture is ONE synthetic speech file in OGG/Opus (Discord's voice
 * format: `OggS`, at most 10 MiB) whose absolute path is
 * AIQSA_DISCORD_VOICE_PAID_AUDIO. It says exactly:
 *
 *   "What is the capital of France? Answer with one word."
 *
 * and both answers must name Paris. Runs only with
 * AIQSA_FEATURES_PAID_E2E=DISPOSABLE, CODEX_LB_API_KEY, CODEX_LB_BASE_URL,
 * OPENROUTER_API_KEY and that fixture on a disposable test-mode stand (the
 * fake Discord's origins are honoured only in test mode).
 * AIQSA_DISCORD_VOICE_PAID_MODEL overrides the Whisper model (default
 * openai/whisper-1). The administrator's Speech to text Test & save is one
 * more paid call with the bundled synthetic sample.
 *
 * Oracles: the journal rows, the answers' text, the chats' user turns (the
 * transcript marked as one) and the service account's `speech_to_text` usage
 * rows. Annotations carry states, codes, counts and booleans only, never the
 * key, the transcript or the answers. The role is cleared (a role that existed
 * before is put back) and an OpenRouter connection this spec created is
 * deleted afterwards; the codex-lb connection stays on the disposable stand.
 */

const audioPath = paidEnv("AIQSA_DISCORD_VOICE_PAID_AUDIO");
const audioReady = audioPath !== null && isAbsolute(audioPath) && existsSync(audioPath) && statSync(audioPath).size <= DICTATION_AUDIO_MAX_BYTES;
const paid = process.env.AIQSA_FEATURES_PAID_E2E === "DISPOSABLE" && paidEnv("CODEX_LB_API_KEY") !== null &&
  paidEnv("CODEX_LB_BASE_URL") !== null && paidEnv("OPENROUTER_API_KEY") !== null;

test.describe.configure({ mode: "serial", timeout: PAID_TURN_TIMEOUT_MS + 60_000 });
test.use({ screenshot: "off", trace: "off", video: "off" });
test.skip(!paid, "paid Discord voice check is opt-in: AIQSA_FEATURES_PAID_E2E=DISPOSABLE, CODEX_LB_API_KEY, CODEX_LB_BASE_URL and OPENROUTER_API_KEY");
test.skip(!audioReady, "paid Discord voice check needs AIQSA_DISCORD_VOICE_PAID_AUDIO, an absolute path to an OGG/Opus speech file of at most 10 MiB");

const STT_ENDPOINT = "/api/admin/providers/speech-to-text";
const STT_MODEL = paidEnv("AIQSA_DISCORD_VOICE_PAID_MODEL") ?? "openai/whisper-1";
/** What Discord states as the voice message's length; the fixture is a few seconds. */
const DURATION_SECS = 4;
const TRANSCRIPT_MARK = "[Transcript of a voice message from";

const prisma = new PrismaClient();
const people = createPeopleFixture(prisma);
const assistants = createAssistantFixture(prisma, { suffix: people.suffix });

let stand: DiscordStand;
let adminSession: E2ESession;
let model: PaidAnswerModel;
let audio: Buffer;
let alice: string;
let bob: string;
let serviceUserId: string;
let startedAt: Date;
let createdConnectionId: string | null = null;
let priorPolicy: Readonly<{ speechToTextConfiguredAt: Date | null; speechToTextConnectionId: string | null;
  speechToTextCredentialVersionId: string | null; speechToTextModelId: string | null }> | null = null;

async function readRole(request: APIRequestContext): Promise<AdminSpeechToTextRole> {
  const response = await request.get(STT_ENDPOINT);
  expect(response.ok(), `the Speech to text role is readable (${response.status()})`).toBe(true);
  const role = decodeAdminSpeechToTextResponse(await response.json());
  expect(role, "the Speech to text role decodes").not.toBeNull();
  return role!;
}

async function openRouterConnectionIds(request: APIRequestContext): Promise<Set<string>> {
  const connections = readConnections(await (await request.get("/api/admin/providers")).json()) ?? [];
  return new Set(connections.filter((connection) => connection.family === "openrouter").map((connection) => connection.id));
}

async function answered(question: FakeDiscordMessage, since: number): Promise<DiscordReplyView> {
  const reply = await waitForDiscordReply(prisma, stand.fake, question.id, { since, timeout: PAID_TURN_TIMEOUT_MS });
  expect(reply.state, `answer state (${reply.code ?? "no code"})`).toBe("delivered");
  await waitForAnsweredReactions(stand.fake, question.id, PAID_TURN_TIMEOUT_MS);
  return reply;
}

/** The service account's transcriptions since the spec started. */
async function transcriptions(): Promise<number> {
  return prisma.usageEvent.count({ where: { createdAt: { gte: startedAt }, modelId: STT_MODEL, purpose: "speech_to_text", userId: serviceUserId } });
}

/** The answer names Paris and the run read the transcript, marked as one, that asked about France's capital. */
async function expectAnsweredFromVoice(reply: DiscordReplyView, label: string): Promise<void> {
  const answer = answerMessage(stand.fake, reply);
  const text = await chatUserText(prisma, reply.chatId!);
  const facts = {
    marked: text.includes(TRANSCRIPT_MARK), capital: /\bcapital\b/iu.test(text), france: /\bfrance\b/iu.test(text),
    paris: /\bparis\b/iu.test(answer.content)
  };
  test.info().annotations.push({ description: JSON.stringify(facts), type: label });
  expect(facts.marked, "the run reads the voice message as a marked transcript").toBe(true);
  expect(facts.capital && facts.france, "the transcript carries the spoken question").toBe(true);
  expect(facts.paris, "the answer names Paris").toBe(true);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(2 * PAID_SETUP_TIMEOUT_MS + 120_000);
  audio = readFileSync(audioPath!);
  expect(audio.subarray(0, 4).toString("latin1"), "the fixture is an Ogg file").toBe("OggS");
  startedAt = new Date();
  stand = await startDiscordStand(["dc-voice"]);
  alice = stand.fake.addUser({ globalName: "Alice", username: `alice_${people.suffix}` });
  bob = stand.fake.addUser({ globalName: "Bob", username: `bob_${people.suffix}` });
  adminSession = await people.signIn(browser, (await people.admin("Discord voice admin"))!);
  const request = adminSession.page.request;
  await disableDiscord(request);

  priorPolicy = await prisma.systemModelPolicy.findUnique({ where: { id: "installation" }, select: {
    speechToTextConfiguredAt: true, speechToTextConnectionId: true, speechToTextCredentialVersionId: true, speechToTextModelId: true } });
  const before = await openRouterConnectionIds(request);
  const connectionId = await openRouterConnection(request, paidEnv("OPENROUTER_API_KEY")!, { reuse: false });
  if (!before.has(connectionId)) createdConnectionId = connectionId;
  const role = await readRole(request);
  const saved = await request.post(STT_ENDPOINT, { timeout: PAID_SETUP_TIMEOUT_MS, data: {
    action: "test_and_save", connectionId, expectedConfiguredAt: role.configuredAt, modelId: STT_MODEL } });
  expect(saved.ok(), `the paid Speech to text Test passes (${saved.status()})`).toBe(true);
  expect(decodeAdminSpeechToTextResponse(await saved.json())?.assignment).toMatchObject({ available: true, connectionId, modelId: STT_MODEL });

  // No Search row: after OpenRouter Quick Setup, which turns on its family's Search source, the owner's catalog refused the
  // codex-lb search option for this Assistant (`assistant_search_option_not_available`), and the spoken question needs no search.
  model = await setupCodexLbAnswerModel(request, { label: "Discord voice", nativeSearch: false, preferredModel: paidEnv("AIQSA_FEATURES_CODEX_MODEL") });
  const assistant = await assistants.create(request, {
    name: "Discord voice agent",
    rows: { model: { policy: "fixed", value: { mode: "model", modelId: model.modelId } } },
    systemPrompt: "You answer questions asked in a Discord server. Keep answers short."
  });
  await assistants.publish(request, assistant.id, "installation");
  const state = await configureDiscordByApi(request, prisma, stand.fake, {
    assistantId: assistant.id, channelIds: [stand.channels["dc-voice"]!], dmEnabled: true
  });
  serviceUserId = state.serviceAccount.userId!;
});

test.afterAll(async () => {
  try {
    if (adminSession) {
      const request = adminSession.page.request;
      await disableDiscord(request).catch(() => undefined);
      const role = await readRole(request).catch(() => null);
      if (role?.assignment) await request.post(STT_ENDPOINT, { data: { action: "clear", expectedConfiguredAt: role.configuredAt } }).catch(() => null);
      if (priorPolicy?.speechToTextConnectionId) {
        await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: priorPolicy }).catch(() => undefined);
      }
      if (createdConnectionId) {
        await request.delete(`/api/admin/providers/${encodeURIComponent(createdConnectionId)}`, { data: { confirmed: true } }).catch(() => null);
      }
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

test("a voice message in a direct message is answered from what it says", async () => {
  const { fake } = stand;
  const dm = fake.openDm(alice);
  const since = fake.calls().length;
  const question = sayVoice(fake, { audio, authorId: alice, channelId: dm, durationSecs: DURATION_SECS });
  const reply = await answered(question, since);
  expect(reply.conversationKind).toBe("dm");
  await expectAnsweredFromVoice(reply, "direct-message");
  expect(await pollUntil(30_000, async () => (await transcriptions()) >= 1 ? true : null, "voice_usage_timeout"),
    "the transcription is the service account's speech_to_text row").toBe(true);
});

test("a mention in a Reply to someone's voice message lets the agent answer about its content", async () => {
  const { fake } = stand;
  const channel = stand.channels["dc-voice"]!;
  const voice = sayVoice(fake, { audio, authorId: bob, channelId: channel, durationSecs: DURATION_SECS });
  const since = fake.calls().length;
  const question = say(fake, {
    authorId: alice, channelId: channel, mention: true, replyTo: voice.id,
    text: "Answer the question asked in the voice message I am replying to."
  });
  const reply = await answered(question, since);
  await expectAnsweredFromVoice(reply, "reply-to-voice");
  const rows = await pollUntil(30_000, async () => { const count = await transcriptions(); return count >= 2 ? count : null; }, "voice_usage_timeout");
  test.info().annotations.push({ description: `speech_to_text rows ${rows}`, type: "usage" });
  // One transcription per question: Bob's message was transcribed only because Alice asked about it.
  expect(rows).toBe(2);
});
