/**
 * Opt-in, paid browser check of the Skills a release ships
 * (`lib/server/skills/shippedSkills.ts`) on a DISPOSABLE stand. It runs the
 * upgrade's bootstrap step (`synchronizeShippedSkills`) on the stand's
 * database, then checks that a user who never touched Skills has
 * `health-questions` built in and on, that an administrator's switch turns
 * it off and on for everyone, and that a real Codex LB turn on a health
 * question offers the Skill and loads it. Never a default lane: it runs only
 * with AIQSA_FEATURES_PAID_E2E=DISPOSABLE plus CODEX_LB_API_KEY and
 * CODEX_LB_BASE_URL (see `setupCodexLbAnswerModel`).
 *
 * Expected paid calls (Codex LB only): custom setup once (discovery plus its
 * model checks) and one turn of about two model requests (`load_skill`, then
 * the answer). Oracles are persisted rows (definitions, runs, manifests,
 * bindings) and the rendered library and Control Center, never the model's
 * wording; nothing prints prompts, answers or values.
 */
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { hashPassword } from "../../lib/server/auth/password";
import { provisionActiveUser } from "../../lib/server/auth/provisioning";
import { synchronizeShippedSkills } from "../../lib/server/bootstrap/shippedSkills";
import { loadShippedSkills } from "../../lib/server/skills/shippedSkills";
import { runAccountMenuAction } from "./shell/page";
import { captureState } from "./support/capture";
import { expectCenterUnobscured, expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";
import { deletePaidChat, newExcludedChat, paidEnv, pollUntil, setupCodexLbAnswerModel, PAID_TURN_TIMEOUT_MS } from "./support/paidProviders";
import { loginWithPassword } from "./support/workspace";

const prisma = new PrismaClient();

test.skip(process.env.AIQSA_FEATURES_PAID_E2E !== "DISPOSABLE", "paid: requires AIQSA_FEATURES_PAID_E2E=DISPOSABLE on a disposable stand");
test.skip(!paidEnv("CODEX_LB_API_KEY") || !paidEnv("CODEX_LB_BASE_URL"), "paid: requires CODEX_LB_API_KEY and CODEX_LB_BASE_URL");
test.describe.configure({ mode: "serial" });
test.use({ locale: "en-US", contextOptions: { reducedMotion: "reduce" } });
test.afterAll(() => prisma.$disconnect());

const KEY = "health-questions";
const ACTIVE_RUN_STATUSES = ["preparing", "queued", "streaming", "in_progress"];
let skillId = "";
const user = { id: randomUUID(), email: `shipped-${randomUUID()}@example.test`, password: `Synthetic-${randomUUID()}`, displayName: "Shipped Skill user" };

test.beforeAll(async () => {
  // The upgrade's bootstrap step; the same release again writes nothing.
  const first = await synchronizeShippedSkills(prisma, loadShippedSkills());
  expect(first.retired).toBe(0);
  expect(await synchronizeShippedSkills(prisma, loadShippedSkills())).toEqual({ created: 0, updated: 0, retired: 0 });
  const definition = await prisma.skillDefinition.findUniqueOrThrow({ where: { shippedKey: KEY } });
  expect(definition).toMatchObject({ ownerUserId: null, archivedAt: null, deletedAt: null });
  skillId = definition.id;
  const fullAccess = await prisma.group.findUniqueOrThrow({ where: { systemRole: "full_access" }, select: { id: true } });
  await prisma.user.create({ data: { id: user.id, email: user.email, displayName: user.displayName, status: "active", authIdentities: { create: {
    normalizedEmail: user.email, provider: "password", providerAccountId: user.email,
    passwordHash: await hashPassword(user.password), emailVerifiedAt: new Date()
  } } } });
  await prisma.$transaction((tx) => provisionActiveUser(tx, { userId: user.id, groups: [{ groupId: fullAccess.id, role: "member" }] }));
});

async function capture(page: Page, anchor: Locator, testInfo: TestInfo, surface: string) {
  await captureState(page, testInfo, `shipped-skills-${surface}`, {
    anchor,
    atEachSize: async () => {
      await expectWithinViewport(page, anchor);
      await expectCenterUnobscured(anchor);
      await expectNoHorizontalOverflow(page);
    }
  });
}

async function openLibrary(page: Page): Promise<Locator> {
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await runAccountMenuAction(page, "Assistants");
  await page.getByTestId("library-v2").getByRole("tab", { name: "Skills", exact: true }).click();
  const library = page.getByTestId("skill-library-section");
  await library.getByRole("searchbox", { name: "Search Skills" }).fill(KEY);
  return library;
}

test("a user who never touched Skills has the shipped Skill built in and on, and an administrator turns it off and on for everyone", async ({ page: admin, browser, baseURL }, testInfo) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ baseURL, reducedMotion: "reduce" });
  const page = await context.newPage();
  try {
    await loginWithPassword(page, user);
    const library = await openLibrary(page);
    await expect(library.getByText(/Built in · By AIQSA/u)).toBeVisible();
    await expect(library.getByRole("switch", { name: `Auto load: ${KEY}` })).toHaveAttribute("aria-checked", "true");
    await library.getByRole("button", { name: `Open ${KEY}`, exact: true }).click();
    const detail = library.getByRole("region", { name: "Skill detail", exact: true });
    await expect(detail.getByText("Comes with AIQSA for everyone. An administrator can turn it off for the whole installation.")).toBeVisible();
    for (const name of ["Edit", "Delete…", "Export"]) await expect(detail.getByRole("button", { name, exact: true })).toHaveCount(0);
    await capture(page, detail, testInfo, "library-detail");

    await signInWithLocalToken(admin);
    await admin.goto("/admin?section=skills");
    await expect(admin.getByTestId("admin-skills-section")).toBeVisible();
    const block = admin.getByRole("region", { name: "Built-in Skills" });
    const toggle = block.getByRole("switch", { name: `Available to everyone: ${KEY}` });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await capture(admin, block, testInfo, "admin");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(block.getByText(/Off for everyone\./u)).toBeVisible();
    expect((await prisma.skillDefinition.findUniqueOrThrow({ where: { id: skillId } })).archivedAt).not.toBeNull();
    const hidden = await openLibrary(page);
    await expect(hidden.getByRole("button", { name: `Open ${KEY}`, exact: true })).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    const restored = await openLibrary(page);
    await expect(restored.getByRole("button", { name: `Open ${KEY}`, exact: true })).toBeVisible();
  } finally {
    await prisma.skillDefinition.update({ where: { id: skillId }, data: { archivedAt: null } });
    await context.close();
  }
});

test("a real turn on a health question offers the shipped Skill and loads it", async ({ page: admin, browser, baseURL }) => {
  test.setTimeout(900_000);
  await signInWithLocalToken(admin);
  const model = await setupCodexLbAnswerModel(admin.request, { label: "Shipped Skill", nativeSearch: false });
  const context = await browser.newContext({ baseURL, reducedMotion: "reduce" });
  const page = await context.newPage();
  let chatId = "";
  try {
    await loginWithPassword(page, user);
    chatId = await newExcludedChat(page.request, "Shipped Skill check");
    const chat = await prisma.chat.findUniqueOrThrow({ where: { id: chatId }, select: { activeLeafMessageId: true } });
    const text = "My 6-year-old has had a fever of 38.7 °C since last night and a sore throat. What can I give her, and when should we see a doctor?";
    const response = await page.request.post(`/api/chats/${chatId}/messages`, { timeout: PAID_TURN_TIMEOUT_MS, data: {
      content: { blocks: [{ text, type: "text" }] }, expectedActiveLeafId: chat.activeLeafMessageId,
      mcp: { mode: "off" }, modelId: model.modelId, params: model.params, provider: model.connectionId,
      searchPlan: { mode: "all_selected", optionIds: [] }, skills: { mode: "auto" }, timeZone: "UTC", workspace: { enabled: false }
    } });
    expect(response.ok(), `the paid turn is accepted (${response.status()})`).toBe(true);
    await response.body();
    const newest = await prisma.modelRun.findFirstOrThrow({ where: { chatId }, orderBy: { createdAt: "desc" } });
    const run = await pollUntil(PAID_TURN_TIMEOUT_MS, async () => {
      const current = await prisma.modelRun.findUniqueOrThrow({ where: { id: newest.id } });
      return ACTIVE_RUN_STATUSES.includes(current.status) ? null : current;
    }, "paid_turn_timeout");
    expect(run.status, `the paid turn completes (${run.status})`).toBe("complete");
    expect(run.engine).toBe("native");
    const current = (await prisma.skillDefinition.findUniqueOrThrow({ where: { id: skillId } })).currentRevisionId;
    const manifest = (run.normalizedRequest as { skills?: { available?: Array<{ skillId: string; revisionId: string }> } }).skills;
    expect(manifest?.available).toContainEqual(expect.objectContaining({ skillId, revisionId: current }));
    const bindings = await prisma.modelRunSkillBinding.findMany({ where: { modelRunId: run.id, skillId } });
    expect(bindings, "the agent loaded the shipped Skill").toEqual([expect.objectContaining({ mode: "loaded", revisionId: current })]);
    test.info().annotations.push({ type: "shipped-skill", description: JSON.stringify({ status: run.status, offered: true, loaded: bindings.length }) });
  } finally {
    if (chatId) await deletePaidChat(page.request, chatId);
    await context.close();
  }
});
