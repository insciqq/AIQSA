import { createHash, randomInt, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { DISCORD_COPY, DISCORD_WORKSPACE_COPY } from "../../lib/server/discord/copy";
import { getWorkspaceConfig, WorkspaceConfigError, type WorkspaceConfig } from "../../lib/server/workspace/config";
import type { FakeDiscordMessage } from "../support/fakeDiscord";
import { createAssistantFixture } from "./support/assistants";
import {
  answerMessage, configureDiscordByApi, disableDiscord, discordReply, say, startDiscordStand, waitForAnsweredReactions, waitForDiscordReply,
  type DiscordReplyView, type DiscordStand
} from "./support/discordStand";
import { PAID_SETUP_TIMEOUT_MS, paidEnv, setupCodexLbAnswerModel, type PaidAnswerModel } from "./support/paidProviders";
import { createPeopleFixture, type E2ESession } from "./support/people";

/**
 * Opt-in paid check that a Discord turn has the Workspace like a web chat
 * (operator decision 2026-11-16): the fake Discord on the stand's loopback
 * ports (`tests/e2e/support/discordStand.ts`), a REAL codex-lb answer model
 * behind the Discord Assistant, and a REAL KVM Workspace runner. Two threads:
 *
 * 1. A question that needs code runs a script in its thread's Workspace; the
 *    answer carries the file the script wrote to the turn's output folder as a
 *    Discord attachment with the right content.
 * 2. A second thread, whose question carries a file type only the Workspace
 *    takes (`.dat`), gets a Workspace of its own: another session and VM,
 *    where the first thread's file does not exist, and the file reaches it.
 *
 * With AIQSA_DISCORD_WORKSPACE_PARALLEL=<2..16> a third test asks that many
 * threads at once, each sleeping in its own VM, and records how each ended:
 * the capacity probe behind the decision on a Discord Workspace cap. Run it
 * while sampling the runner (see the report of `discord-workspace`).
 *
 * Runs only with AIQSA_FEATURES_PAID_E2E=DISPOSABLE, CODEX_LB_API_KEY and
 * CODEX_LB_BASE_URL on a disposable test-mode stand whose app uses a live
 * runner: export for `playwright test`, as `native-workspace-paid.spec.ts`
 * describes (`playwright.config.ts` passes them to the web server):
 *
 *   AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME=0
 *   AIQSA_WORKSPACE_RUNNER_URL=<the runner's http(s) URL>
 *   AIQSA_WORKSPACE_RUNNER_TOKEN=<the runner's own token>
 *
 * AIQSA_FEATURES_CODEX_MODEL picks the codex-lb model. The installation's
 * Workspace policy must be on (the seed turns it on); the guest needs no
 * internet. The Discord control row is the installation's singleton, so this
 * spec runs alone, after or before the other Discord specs, and leaves the bot
 * disabled. Assertions and annotations carry states, codes, booleans, counts
 * and durations; answers, prompts and keys are never printed, and traces,
 * screenshots and videos stay off. The service account's chats, and with them
 * their Workspaces until the idle stop and retention end them, stay on the
 * disposable stand like the other Discord specs' chats.
 *
 * Expected paid calls (codex-lb only): setup once; each Workspace turn about
 * two to five model requests (write and run the script, maybe fix it,
 * answer); the probe as many turns as it asks.
 */

const paid = process.env.AIQSA_FEATURES_PAID_E2E === "DISPOSABLE" && paidEnv("CODEX_LB_API_KEY") !== null &&
  paidEnv("CODEX_LB_BASE_URL") !== null;

/** The app's Workspace configuration as the web server resolves it from this process's environment. */
function appWorkspaceConfig(): WorkspaceConfig | string {
  try {
    const config = getWorkspaceConfig({ ...process.env, AIQSA_TEST_MODE: "1",
      AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: process.env.AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME?.trim() || "1" });
    return config.runtimeMode === "remote" ? config : config.runtimeMode;
  } catch (error) {
    return error instanceof WorkspaceConfigError ? error.code : "workspace_config_invalid";
  }
}

const workspaceConfig = appWorkspaceConfig();
const parallelSetting = Number(process.env.AIQSA_DISCORD_WORKSPACE_PARALLEL?.trim() || "0");
const PARALLEL = Number.isSafeInteger(parallelSetting) && parallelSetting >= 2 && parallelSetting <= 16 ? parallelSetting : 0;

/** A first VM may pull its image; a Workspace turn then writes, runs and maybe fixes a script. */
const WORKSPACE_TURN_TIMEOUT_MS = 900_000;

test.describe.configure({ mode: "serial", timeout: WORKSPACE_TURN_TIMEOUT_MS + 120_000 });
test.use({ screenshot: "off", trace: "off", video: "off" });
test.skip(!paid, "paid Discord check is opt-in: AIQSA_FEATURES_PAID_E2E=DISPOSABLE, CODEX_LB_API_KEY and CODEX_LB_BASE_URL");
test.skip(typeof workspaceConfig === "string", `requires a real Workspace runner: the app's Workspace runtime resolves to ${
  typeof workspaceConfig === "string" ? workspaceConfig : "remote"} (set AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME=0, ` +
  "AIQSA_WORKSPACE_RUNNER_URL and AIQSA_WORKSPACE_RUNNER_TOKEN)");

const prisma = new PrismaClient();
const people = createPeopleFixture(prisma);
const assistants = createAssistantFixture(prisma, { suffix: people.suffix });

let stand: DiscordStand;
let adminSession: E2ESession;
let model: PaidAnswerModel;
let alice: string;
let bob: string;
/** The first thread's output file and session, which the second thread must not see. */
let first: Readonly<{ fileName: string; chatId: string; sessionId: string; runtimeSandboxId: string }> | null = null;

/** Whether the sandbox identity is the one the deterministic runtime makes for the session's first guest. */
function deterministicSandboxId(session: Readonly<{ id: string; runtimeSandboxId: string | null; sandboxName: string }>): boolean {
  return session.runtimeSandboxId === createHash("sha256").update(["deterministic", session.id, session.sandboxName, "1"].join("\0"))
    .digest("hex");
}

async function answered(question: FakeDiscordMessage, since: number): Promise<DiscordReplyView> {
  const reply = await waitForDiscordReply(prisma, stand.fake, question.id, { since, timeout: WORKSPACE_TURN_TIMEOUT_MS });
  expect(reply.state, `answer state (${reply.code ?? "no code"})`).toBe("delivered");
  await waitForAnsweredReactions(stand.fake, question.id, 60_000);
  return reply;
}

/** The chat's Workspace session, as admission reserved it and the runner started it. */
async function sessionOf(chatId: string) {
  return prisma.workspaceSession.findUnique({ select: { id: true, runtimeSandboxId: true, sandboxName: true }, where: { chatId } });
}

/** The run's Workspace binding once its export settled, and the files it exported from its output folder. */
async function workspaceRun(runId: string) {
  await expect.poll(async () => (await prisma.workspaceRunBinding.findUnique({ select: { exportState: true }, where: { modelRunId: runId } }))
    ?.exportState ?? "none", { message: "the run's Workspace export settles", timeout: 120_000 }).toMatch(/^(?:COMPLETE|FAILED|none)$/u);
  const [binding, outputs] = await Promise.all([
    prisma.workspaceRunBinding.findUnique({ select: { exportState: true, workspaceSessionId: true }, where: { modelRunId: runId } }),
    prisma.workspaceRunOutput.findMany({ select: { attachment: { select: { fileName: true } } }, where: { workspaceRunBindingId: runId } })
  ]);
  return { binding, outputs: outputs.map((output) => output.attachment.fileName) };
}

/** An attachment's bytes as the fake CDN serves them. */
async function attachmentText(attachment: FakeDiscordMessage["attachments"][number]): Promise<string> {
  const response = await stand.fake.handle(new Request(attachment.url));
  expect(response.status, "the fake CDN serves the answer's file").toBe(200);
  return (await response.text()).trim();
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(PAID_SETUP_TIMEOUT_MS + 120_000);
  const config = workspaceConfig as WorkspaceConfig;
  const health = await fetch(new URL("health", `${config.runnerUrl!.toString().replace(/\/?$/u, "/")}`),
    { headers: { authorization: `Bearer ${config.runnerToken!}` }, signal: AbortSignal.timeout(30_000) });
  expect(health.ok, `the Workspace runner is healthy (${health.status})`).toBe(true);
  const policy = await prisma.workspacePolicy.findUnique({ select: { enabled: true }, where: { id: "installation" } });
  expect(policy?.enabled, "the installation's Workspace policy is on").toBe(true);

  stand = await startDiscordStand(["dc-workspace"]);
  alice = stand.fake.addUser({ globalName: "Alice", username: `alice_${people.suffix}` });
  bob = stand.fake.addUser({ globalName: "Bob", username: `bob_${people.suffix}` });
  adminSession = await people.signIn(browser, (await people.admin("Discord Workspace admin"))!);
  const request = adminSession.page.request;
  await disableDiscord(request);
  model = await setupCodexLbAnswerModel(request, {
    label: "Discord Workspace", nativeSearch: false, preferredModel: paidEnv("AIQSA_FEATURES_CODEX_MODEL")
  });
  const assistant = await assistants.create(request, {
    name: "Discord Workspace agent",
    rows: { model: { policy: "fixed", value: { mode: "model", modelId: model.modelId } } },
    systemPrompt: "You answer questions asked in a Discord server. Keep answers short. Use the Workspace when a question asks you to run code."
  });
  await assistants.publish(request, assistant.id, "installation");
  await configureDiscordByApi(request, prisma, stand.fake, { assistantId: assistant.id, channelIds: [stand.channels["dc-workspace"]!] });
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

test("a question that needs code runs it in the thread's Workspace and the answer carries its output file", async () => {
  const { fake } = stand;
  const [left, right] = [randomInt(101, 999), randomInt(101, 999)];
  const fileName = `product-${randomUUID().slice(0, 8)}.txt`;
  const since = fake.calls().length;
  const question = say(fake, {
    authorId: alice, channelId: stand.channels["dc-workspace"]!, mention: true,
    text: `Use the Workspace: write and run a Python script that computes ${left} multiplied by ${right} and saves only the ` +
      `result as a text file named ${fileName} in this turn's output folder, so it is attached to your answer. Do not compute it ` +
      "yourself. Then reply with the result only."
  });
  const reply = await answered(question, since);
  const answer = answerMessage(fake, reply);
  const run = await workspaceRun(reply.runId!);
  const session = await sessionOf(reply.chatId!);
  const attached = answer.attachments.find((attachment) => attachment.filename === fileName);
  test.info().annotations.push({
    description: `thread ${reply.conversationKind}, binding ${run.binding ? run.binding.exportState : "none"}, outputs ${run.outputs.length}, ` +
      `attachments ${answer.attachments.length}, named file ${attached ? "attached" : "missing"}`,
    type: "workspace"
  });

  expect(reply.conversationKind, "a channel mention opens the bot's thread").toBe("thread");
  expect(run.binding, "the run had the thread's Workspace").not.toBeNull();
  expect(run.binding!.exportState, "the turn's outputs were exported").toBe("COMPLETE");
  expect(session?.runtimeSandboxId ?? null, "the thread's chat has a real VM").not.toBeNull();
  expect(deterministicSandboxId(session!), "the VM is not the deterministic runtime's").toBe(false);
  expect(run.binding!.workspaceSessionId).toBe(session!.id);
  expect(run.outputs, "the script's file is among the turn's outputs").toContain(fileName);
  expect(attached, "the answer carries the output file as a Discord attachment").toBeDefined();
  expect(await attachmentText(attached!), "the attached file holds the script's result").toBe(String(left * right));
  expect(answer.content.includes(String(left * right)), "the answer states the result").toBe(true);
  first = { chatId: reply.chatId!, fileName, runtimeSandboxId: session!.runtimeSandboxId!, sessionId: session!.id };
});

test("a second thread keeps a Workspace of its own, which takes a file only the Workspace reads", async () => {
  test.skip(first === null, "needs the first thread's Workspace");
  const { fake } = stand;
  const numbers = Array.from({ length: 6 }, () => randomInt(10, 99));
  const sum = numbers.reduce((total, value) => total + value, 0);
  const since = fake.calls().length;
  const question = say(fake, {
    attachments: [{ contentType: "application/octet-stream", data: Buffer.from(`${numbers.join("\n")}\n`), filename: "numbers.dat" }],
    authorId: bob, channelId: stand.channels["dc-workspace"]!, mention: true,
    text: "Use the Workspace and a Python script for both: add up the integers in the attached numbers.dat, and check whether a file " +
      `named ${first!.fileName} exists anywhere under /workspace. Reply with exactly two lines: SUM=<the sum> and FILE=<EXISTS or MISSING>.`
  });
  const reply = await answered(question, since);
  const answer = answerMessage(fake, reply);
  const session = await sessionOf(reply.chatId!);
  const run = await workspaceRun(reply.runId!);
  // The service account's uploads: a `.dat` is a file only the Workspace reads (no attachment format lists it).
  const owner = (await prisma.chat.findUniqueOrThrow({ select: { userId: true }, where: { id: reply.chatId! } })).userId;
  const opaque = await prisma.attachment.count({ where: { fileName: "numbers.dat", kind: "file", userId: owner } });
  const statedSum = /SUM=\s*(\d+)/u.exec(answer.content)?.[1] ?? null;
  const statedFile = /FILE=\s*(EXISTS|MISSING)/u.exec(answer.content)?.[1] ?? null;
  test.info().annotations.push({
    description: `own chat ${reply.chatId !== first!.chatId}, own session ${session?.id !== first!.sessionId}, own VM ${
      session?.runtimeSandboxId !== first!.runtimeSandboxId}, opaque uploads ${opaque}, sum matches ${statedSum === String(sum)}, file ${statedFile}`,
    type: "workspace"
  });

  expect(reply.chatId, "the second thread is another chat").not.toBe(first!.chatId);
  expect(run.binding, "the second run had a Workspace").not.toBeNull();
  expect(session, "the second chat has a Workspace session").not.toBeNull();
  expect(session!.id, "the second thread's Workspace is another session").not.toBe(first!.sessionId);
  expect(session!.runtimeSandboxId ?? null, "the second thread's Workspace has its own VM").not.toBeNull();
  expect(session!.runtimeSandboxId, "the second thread's VM is not the first's").not.toBe(first!.runtimeSandboxId);
  expect(opaque, "the .dat file went up in the Workspace scope, as a file only the Workspace reads").toBeGreaterThan(0);
  expect(statedSum, "the answer states the sum of the attached file").toBe(String(sum));
  expect(statedFile, "the first thread's file is not in the second thread's Workspace").toBe("MISSING");
});

test("many threads at once each get a Workspace or a visible Workspace reason (capacity probe)", async () => {
  test.skip(PARALLEL === 0, "capacity probe is opt-in: AIQSA_DISCORD_WORKSPACE_PARALLEL=<2..16>");
  test.setTimeout(WORKSPACE_TURN_TIMEOUT_MS + 300_000);
  const { fake } = stand;
  const channel = stand.channels["dc-workspace"]!;
  const authors = Array.from({ length: PARALLEL }, (_, index) => fake.addUser({ username: `probe${index}_${people.suffix}` }));
  const since = fake.calls().length;
  const startedAt = Date.now();
  const questions = authors.map((authorId, index) => ({
    index,
    question: say(fake, {
      authorId, channelId: channel, mention: true,
      text: `Use the Workspace: run a Python script that sleeps 30 seconds and then saves ${index + 2} squared as a text file named ` +
        `square-${index}.txt in this turn's output folder, so it is attached to your answer. Then reply with that number only.`
    })
  }));
  const settled = await Promise.all(questions.map(async ({ index, question }) => {
    const reply = await waitForDiscordReply(prisma, fake, question.id, { since, timeout: WORKSPACE_TURN_TIMEOUT_MS });
    const finished = Date.now() - startedAt;
    const session = reply.chatId ? await sessionOf(reply.chatId) : null;
    const notice = reply.answerMessageId ? fake.messages(reply.answerChannelId).find((message) => message.id === reply.answerMessageId) : null;
    const attached = reply.state === "delivered" && notice ? notice.attachments.some((attachment) => attachment.filename === `square-${index}.txt`)
      : false;
    return { attached, code: reply.code, finished, notice: notice?.content ?? null, runtimeSandboxId: session?.runtimeSandboxId ?? null,
      state: reply.state };
  }));
  const delivered = settled.filter((entry) => entry.state === "delivered");
  const vms = new Set(settled.flatMap((entry) => (entry.runtimeSandboxId ? [entry.runtimeSandboxId] : [])));
  const codes = settled.filter((entry) => entry.state !== "delivered").map((entry) => entry.code ?? "none").sort();
  test.info().annotations.push({
    description: `asked ${PARALLEL}, delivered ${delivered.length}, with file ${delivered.filter((entry) => entry.attached).length}, ` +
      `distinct VMs ${vms.size}, failed codes [${codes.join(", ")}], slowest ${Math.max(...settled.map((entry) => entry.finished))} ms`,
    type: "capacity"
  });
  for (const { question } of questions) expect(await discordReply(prisma, question.id), "every question has its journal row").not.toBeNull();
  const workspaceTexts: readonly string[] = Object.values(DISCORD_WORKSPACE_COPY);
  for (const entry of settled.filter((candidate) => candidate.state !== "delivered")) {
    // A full or busy runner is refused visibly, with the Workspace's own reason, never "Something went wrong".
    expect(entry.code ?? "", "a question that got no answer names a Workspace code").toMatch(/^workspace_/u);
    expect(entry.notice ?? "", "its notice is not the generic one").not.toContain(DISCORD_COPY.somethingWrong);
    expect(workspaceTexts.some((text) => (entry.notice ?? "").includes(text)), "its notice says what the Workspace could not do").toBe(true);
  }
});
