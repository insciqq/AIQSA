import { PrismaClient } from "@prisma/client";
import { expect, test, type APIRequestContext, type PlaywrightWorkerArgs } from "@playwright/test";
import type { FakeDiscordMessage } from "../support/fakeDiscord";
import { createAssistantFixture } from "./support/assistants";
import {
  answerMessage, configureDiscordByApi, disableDiscord, say, startDiscordStand, waitForAnsweredReactions, waitForDiscordReply,
  type DiscordReplyView, type DiscordStand
} from "./support/discordStand";
import { PAID_SETUP_TIMEOUT_MS, PAID_TURN_TIMEOUT_MS, paidEnv, setupCodexLbAnswerModel, type PaidAnswerModel } from "./support/paidProviders";
import { createPeopleFixture, type E2ESession } from "./support/people";

/**
 * Opt-in paid check of Discord artifact links (operator decision 2026-11-16):
 * the fake Discord on the stand's loopback ports, a REAL codex-lb answer model
 * behind the Discord Assistant. A question asks for an artifact; its answer
 * links a public publication of that version (a button on an https
 * installation, a line on the plain-http stand), which opens without signing
 * in and carries noindex. A second question in the same thread has the model
 * update the artifact: its answer links the new version, while the first link
 * still shows the first.
 *
 * Runs only with AIQSA_FEATURES_PAID_E2E=DISPOSABLE, CODEX_LB_API_KEY and
 * CODEX_LB_BASE_URL on a disposable test-mode stand. Public links are bearer
 * credentials: assertions and annotations carry statuses, counts and version
 * numbers only, never links, tokens, prompts or answers, and traces,
 * screenshots and videos stay off. The publications stay with the service
 * account on the disposable stand.
 */

const paid = process.env.AIQSA_FEATURES_PAID_E2E === "DISPOSABLE" && paidEnv("CODEX_LB_API_KEY") !== null &&
  paidEnv("CODEX_LB_BASE_URL") !== null;

test.describe.configure({ mode: "serial", timeout: PAID_TURN_TIMEOUT_MS + 60_000 });
test.use({ screenshot: "off", trace: "off", video: "off" });
test.skip(!paid, "paid Discord check is opt-in: AIQSA_FEATURES_PAID_E2E=DISPOSABLE, CODEX_LB_API_KEY and CODEX_LB_BASE_URL");

const prisma = new PrismaClient();
const people = createPeopleFixture(prisma);
const assistants = createAssistantFixture(prisma, { suffix: people.suffix });
const PUBLIC_LINK = /^https?:\/\/[^/\s<>]+\/a\/([A-Za-z0-9_-]{32,128})$/u;

let stand: DiscordStand;
let adminSession: E2ESession;
let model: PaidAnswerModel;
let alice: string;
/** The first answer's link and the thread it was answered in, for the second test. */
let first: Readonly<{ link: string; threadId: string }> | null = null;

async function answered(question: FakeDiscordMessage, since: number): Promise<DiscordReplyView> {
  const reply = await waitForDiscordReply(prisma, stand.fake, question.id, { since, timeout: PAID_TURN_TIMEOUT_MS });
  expect(reply.state, `answer state (${reply.code ?? "no code"})`).toBe("delivered");
  await waitForAnsweredReactions(stand.fake, question.id, PAID_TURN_TIMEOUT_MS);
  return reply;
}

/** The answer's artifact links: its link buttons (https) and its `Open <title>: <url>` lines (plain http). */
function artifactLinks(message: FakeDiscordMessage): string[] {
  const buttons = (message.components as Array<{ components?: Array<{ label?: unknown; url?: unknown }> }>)
    .flatMap((row) => row.components ?? [])
    .flatMap((button) => typeof button.url === "string" && typeof button.label === "string" && button.label.startsWith("Open ") &&
      button.label !== "Open in AIQSA" ? [button.url] : []);
  const lines = [...message.content.matchAll(/^Open (?!in AIQSA:).*: <(https?:\/\/[^>\s]+)>$/gmu)].map((match) => match[1]!);
  return [...buttons, ...lines].filter((url) => PUBLIC_LINK.test(url));
}

/** A request context with no cookies at all: the link must open signed out. */
async function signedOut(playwright: PlaywrightWorkerArgs["playwright"]): Promise<APIRequestContext> {
  return playwright.request.newContext({ storageState: { cookies: [], origins: [] } });
}

/** Opens the link signed out and returns the version number it shows; asserts noindex on the page and the public API. */
async function openSignedOut(request: APIRequestContext, link: string): Promise<number> {
  const page = await request.get(link, { maxRedirects: 0 });
  expect(page.status(), "the public link opens without signing in").toBe(200);
  const html = await page.text();
  expect(/<meta name="robots" content="[^"]*noindex[^"]*"/u.test(html), "the public page carries a noindex robots meta").toBe(true);
  const token = PUBLIC_LINK.exec(link)![1]!;
  const manifest = await request.get(new URL(`/api/artifact-public/${token}/manifest`, link).toString(), { maxRedirects: 0 });
  expect(manifest.status(), "the public manifest reads without signing in").toBe(200);
  expect(manifest.headers()["x-robots-tag"] ?? "", "the public API sends x-robots-tag noindex").toContain("noindex");
  const body = await manifest.json() as { publication?: { mode?: unknown; defaultVersionNumber?: unknown; versions?: unknown[] } };
  expect(body.publication?.mode, "a single-version publication").toBe("single");
  expect(body.publication?.versions?.length, "it grants exactly one version").toBe(1);
  return Number(body.publication?.defaultVersionNumber);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(PAID_SETUP_TIMEOUT_MS + 120_000);
  stand = await startDiscordStand(["dc-artifacts"]);
  alice = stand.fake.addUser({ globalName: "Alice", username: `alice_${people.suffix}` });
  adminSession = await people.signIn(browser, (await people.admin("Discord artifacts admin"))!);
  const request = adminSession.page.request;
  await disableDiscord(request);
  model = await setupCodexLbAnswerModel(request, { label: "Discord artifacts", nativeSearch: false, preferredModel: paidEnv("AIQSA_FEATURES_CODEX_MODEL") });
  const assistant = await assistants.create(request, {
    name: "Discord artifacts agent",
    rows: { model: { policy: "fixed", value: { mode: "model", modelId: model.modelId } } },
    systemPrompt: "You answer questions asked in a Discord server. Keep answers short. Make artifacts with create_artifact when asked."
  });
  await assistants.publish(request, assistant.id, "installation");
  await configureDiscordByApi(request, prisma, stand.fake, { assistantId: assistant.id, channelIds: [stand.channels["dc-artifacts"]!] });
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

test("an artifact a Discord answer made is linked under it and opens signed out with noindex", async ({ playwright }) => {
  const { fake } = stand;
  const since = fake.calls().length;
  const question = say(fake, {
    authorId: alice, channelId: stand.channels["dc-artifacts"]!, mention: true,
    text: "Make an artifact: a tiny HTML page titled \"Link check\" whose only heading reads \"Version one\". " +
      "Call create_artifact exactly once, then reply with one short sentence."
  });
  const reply = await answered(question, since);
  const links = artifactLinks(answerMessage(fake, reply));
  test.info().annotations.push({ description: `links ${links.length}`, type: "artifact" });
  expect(links.length, "the answer links the one artifact it made").toBe(1);
  const request = await signedOut(playwright);
  try {
    expect(await openSignedOut(request, links[0]!), "the link shows the first version").toBe(1);
  } finally {
    await request.dispose();
  }
  first = { link: links[0]!, threadId: reply.answerChannelId };
});

test("a later answer that edits the artifact links its new version; the first link keeps the first", async ({ playwright }) => {
  expect(first, "the first test linked an artifact").not.toBeNull();
  const { fake } = stand;
  const since = fake.calls().length;
  const question = say(fake, {
    authorId: alice, channelId: first!.threadId, mention: true,
    text: "Update that artifact (create_artifact with intent update and its base_version_id) so its heading reads \"Version two\". " +
      "Call create_artifact exactly once, then reply with one short sentence."
  });
  const reply = await answered(question, since);
  const links = artifactLinks(answerMessage(fake, reply));
  test.info().annotations.push({ description: `links ${links.length}`, type: "artifact" });
  expect(links.length, "the answer links the version it made").toBe(1);
  expect(links[0] === first!.link, "the new version has a link of its own").toBe(false);
  const request = await signedOut(playwright);
  try {
    expect(await openSignedOut(request, links[0]!), "the new link shows the second version").toBe(2);
    expect(await openSignedOut(request, first!.link), "the first link still shows the first version").toBe(1);
  } finally {
    await request.dispose();
  }
});
