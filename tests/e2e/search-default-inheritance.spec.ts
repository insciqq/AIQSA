import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { hashPassword } from "../../lib/server/auth/password";
import { provisionActiveUser } from "../../lib/server/auth/provisioning";
import { builtInSearchDraft, normalizeSearchDraft, searchDraftHash } from "../../lib/server/search/configuration";
import { createTestProviderExecutionAuthority, deleteTestProviderExecutionAuthority } from "../support/providerExecutionAuthority";
import { loginWithPassword, startNewChat } from "./support/workspace";
import { engageComposer } from "./shell/composer";
import { runAccountMenuAction } from "./shell/page";

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());
// A step that cannot act fails where it stands instead of waiting out the test.
test.use({ actionTimeout: 20_000, navigationTimeout: 30_000 });

test("one Search switch serves every chat across navigation, reload and login", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const id = randomUUID();
  const user = { email: `search-inheritance-${id}@example.test`, password: `Synthetic-${randomUUID()}` };
  const authority = await createTestProviderExecutionAuthority(prisma, "search-inheritance");
  const optionId = `search-inheritance-${id}`;
  const on = { mode: "all_selected", optionIds: [optionId] };
  const off = { mode: "all_selected", optionIds: [] };
  try {
    // Catalog-only fixture: no message or Search request is sent, and the
    // credential fixture has no external authority. OpenAI hosted Search is
    // the one hosted source a tool-calling chat can use.
    const model = await prisma.providerModel.findUniqueOrThrow({ where: { id: authority.providerModelId } });
    const activeConfig = { ...model.activeConfig as Prisma.JsonObject, adapterKind: "openai_responses_native",
      capabilities: { ...model.capabilities as Prisma.JsonObject, nativeSearch: true } };
    await prisma.providerModel.update({ where: { id: model.id }, data: { activeConfig, capabilities: activeConfig.capabilities } });
    await prisma.providerConnection.update({ where: { id: authority.connectionId }, data: { family: "openai" } });
    await prisma.providerModelCredentialCheck.create({ data: { ...authority,
      connectionVersion: 1, modelVersion: 1, status: "available", checkedAt: new Date() } });
    const option = await prisma.searchOption.create({ data: { optionId, displayName: "Inheritance Search",
      description: "Synthetic catalog-only Search", kind: "web_search", sourceConnectionId: authority.connectionId } });
    const draft = { ...normalizeSearchDraft(builtInSearchDraft({ kind: "openai_native_web_search", config: {} })) };
    const strategy = await prisma.searchStrategy.create({ data: { searchOptionId: option.id, strategyId: optionId,
      provider: "openai", displayName: "Inheritance Search", kind: "openai_native_web_search", description: "Synthetic Search",
      config: {}, draft, adapterKind: "answer_provider_hosted", credentialMode: "answer_provider" } });
    const revision = await prisma.searchIntegrationRevision.create({ data: { searchStrategyId: strategy.id,
      revisionNumber: 1, adapterKind: "answer_provider_hosted", credentialMode: "answer_provider", configuration: draft,
      validationEvidence: { syntheticCatalogFixture: true }, draftHash: searchDraftHash(draft), validationFingerprint: id } });
    await prisma.searchStrategy.update({ where: { id: strategy.id }, data: { activeRevisionId: revision.id, activatedAt: new Date() } });
    const group = await prisma.group.findFirstOrThrow({ where: { systemRole: "full_access" } });
    await prisma.user.create({ data: { id, email: user.email, displayName: "Search inheritance fixture", status: "active",
      authIdentities: { create: { normalizedEmail: user.email, provider: "password", providerAccountId: user.email,
        passwordHash: await hashPassword(user.password), emailVerifiedAt: new Date() } } } });
    await prisma.$transaction((tx) => provisionActiveUser(tx, { userId: id, groups: [{ groupId: group.id, role: "member" }] }));
    await prisma.userSettings.update({ where: { userId: id }, data: { defaultProviderModelId: model.id, defaultWorkspaceEnabled: false } });
    expect((await prisma.userSettings.findUniqueOrThrow({ where: { userId: id } })).defaultSearchPlan).toBeNull();
    await loginWithPassword(page, user);
    const catalog = async () => {
      const response = await page.request.get("/api/me/catalog");
      expect(response.ok()).toBe(true);
      return (await response.json()).catalog;
    };
    // Search is on for everyone until the user turns it off (operator decisions 2026-10-24 and 2026-11-26); this
    // model searches inside its own answer with the hosted source.
    expect((await catalog()).defaults).toMatchObject({ searchEnabled: true, searchPreferenceSource: "organization" });
    const searchChip = page.getByRole("button", { name: "Web search", exact: true });
    const searchLayer = page.getByRole("dialog", { name: "Web search" });
    const searchSwitch = searchLayer.getByRole("switch", { name: "Search the web" });
    await startNewChat(page);
    await expect(searchChip).toHaveAccessibleDescription("Search: On");
    const created = await page.request.post("/api/chats", { data: { title: "Saved Search choices" } });
    expect(created.ok()).toBe(true);
    const chatId = (await created.json()).chat.id;
    // Chats keep no Search of their own (operator decision 2026-10-24): an older client's write is accepted without
    // storing anything, and one an older release saved on a chat is ignored.
    expect((await page.request.patch(`/api/chats/${chatId}`, { data: { defaultSearchPlan: on } })).ok()).toBe(true);
    expect((await prisma.chat.findUniqueOrThrow({ where: { id: chatId } })).defaultSearchPlan).toBeNull();
    await prisma.chat.update({ where: { id: chatId }, data: { defaultSearchPlan: off } });
    await page.goto(`/c/${chatId}`);
    await expect(searchChip).toHaveAccessibleDescription("Search: On");
    // The composer never turns Search off: one switch, on and locked, and no source list.
    await searchChip.click();
    await expect(searchSwitch).toHaveAttribute("aria-checked", "true");
    await expect(searchSwitch).toBeDisabled();
    await expect(searchLayer.getByRole("checkbox")).toHaveCount(0);
    await expect(searchLayer).toContainText("To turn search off, use Chat defaults in Settings.");
    await page.keyboard.press("Escape");
    await expect(searchChip).toBeFocused();

    // Off only in Chat defaults, after a confirmation, and for every chat.
    await runAccountMenuAction(page, "Chat defaults");
    const settings = page.getByTestId("library-v2");
    const defaultSwitch = settings.getByRole("switch", { name: "Web search default" });
    await expect(defaultSwitch).toHaveAttribute("aria-checked", "true");
    const confirmation = page.getByRole("dialog", { name: "Turn off web search" });
    await defaultSwitch.click();
    await expect(confirmation).toContainText("Answers will get worse.");
    await confirmation.getByRole("button", { name: "Keep search on" }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(defaultSwitch).toHaveAttribute("aria-checked", "true");
    expect((await prisma.userSettings.findUniqueOrThrow({ where: { userId: id } })).defaultSearchPlan).toBeNull();
    await defaultSwitch.click();
    await confirmation.getByRole("button", { name: "Confirm turn off" }).click();
    await expect.poll(async () => (await prisma.userSettings.findUniqueOrThrow({ where: { userId: id } })).defaultSearchPlan).toEqual(off);
    await expect(defaultSwitch).toHaveAttribute("aria-checked", "false");
    await settings.getByRole("button", { name: "Back to chat" }).click();
    await expect(searchChip).toHaveAccessibleDescription("Search: Off");
    await expect(searchChip).toContainText("Search off");
    await startNewChat(page);
    await expect(searchChip).toHaveAccessibleDescription("Search: Off");
    await page.goto("about:blank");
    await page.request.post("/api/auth/logout", { data: {} });
    await prisma.$transaction((tx) => provisionActiveUser(tx, { userId: id }));
    await loginWithPassword(page, user);
    await startNewChat(page);
    await expect(searchChip).toHaveAccessibleDescription("Search: Off");
    expect((await catalog()).defaults).toMatchObject({ searchEnabled: false, searchPreferenceSource: "personal" });

    // The composer's switch turns Search back on everywhere, without a confirmation, and leaves the chat's own
    // column untouched; on is stored as no personal plan.
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto(`/c/${chatId}`);
      await engageComposer(page);
      await searchChip.click();
      await page.screenshot({ path: testInfo.outputPath(`search-switch-${viewport.width}.png`) });
      if (await searchSwitch.getAttribute("aria-checked") !== "true") await searchSwitch.click();
      await expect(searchSwitch).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("Escape");
    }
    await expect.poll(async () => (await prisma.userSettings.findUniqueOrThrow({ where: { userId: id } })).defaultSearchPlan).toBeNull();
    expect((await prisma.chat.findUniqueOrThrow({ where: { id: chatId } })).defaultSearchPlan).toEqual(off);
    await expect(searchChip).toHaveAccessibleDescription("Search: On");
    // Below 1024px the chat list is a drawer; New chat is in reach again at the desktop size.
    await page.setViewportSize({ width: 1440, height: 900 });
    await startNewChat(page);
    await expect(searchChip).toHaveAccessibleDescription("Search: On");
    expect((await catalog()).defaults).toMatchObject({ searchEnabled: true });
    await prisma.userGroup.deleteMany({ where: { userId: id } });
    const restricted = await catalog();
    expect(restricted.search?.reason).toBe("search_not_granted");
    expect(restricted.searchStrategies).toEqual([]);
    expect(await prisma.modelRun.count({ where: { userId: id } })).toBe(0);
  } finally {
    await prisma.user.deleteMany({ where: { id } });
    await prisma.searchStrategy.updateMany({ where: { strategyId: optionId }, data: { activeRevisionId: null } });
    await prisma.searchIntegrationRevision.deleteMany({ where: { searchStrategy: { strategyId: optionId } } });
    await prisma.searchStrategy.deleteMany({ where: { strategyId: optionId } });
    await prisma.searchOption.deleteMany({ where: { optionId } });
    await prisma.providerModelCredentialCheck.deleteMany({ where: { connectionId: authority.connectionId } });
    await deleteTestProviderExecutionAuthority(prisma, authority);
  }
});
