import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { hashPassword } from "../../lib/server/auth/password";
import { provisionActiveUser } from "../../lib/server/auth/provisioning";
import { builtInSearchDraft, normalizeSearchDraft, searchDraftHash } from "../../lib/server/search/configuration";
import { createTestProviderExecutionAuthority, deleteTestProviderExecutionAuthority } from "../support/providerExecutionAuthority";
import { chooseSearchStrategy } from "./shell/composer";
import { loginWithPassword, startNewChat } from "./support/workspace";
import { runAccountMenuAction } from "./shell/page";

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

test("Search defaults and saved personal and Project choices survive navigation, reload and login", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const id = randomUUID();
  const user = { email: `search-inheritance-${id}@example.test`, password: `Synthetic-${randomUUID()}` };
  const authority = await createTestProviderExecutionAuthority(prisma, "search-inheritance");
  const priorPolicy = await prisma.searchPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  const optionId = `search-inheritance-${id}`;
  const google = { mode: "all_selected", optionIds: [optionId] };
  const off = { mode: "all_selected", optionIds: [] };
  let projectId: string | undefined;
  try {
    // Catalog-only fixture: no message or Search request is sent, and the
    // credential fixture has no external authority.
    const model = await prisma.providerModel.findUniqueOrThrow({ where: { id: authority.providerModelId } });
    const activeConfig = { ...model.activeConfig as Prisma.JsonObject, adapterKind: "gemini_interactions_native",
      capabilities: { ...model.capabilities as Prisma.JsonObject, nativeSearch: true } };
    await prisma.providerModel.update({ where: { id: model.id }, data: { activeConfig, capabilities: activeConfig.capabilities } });
    await prisma.providerConnection.update({ where: { id: authority.connectionId }, data: { family: "gemini" } });
    await prisma.providerModelCredentialCheck.create({ data: { ...authority,
      connectionVersion: 1, modelVersion: 1, status: "available", checkedAt: new Date() } });
    const option = await prisma.searchOption.create({ data: { optionId, displayName: "Google Search",
      description: "Synthetic catalog-only Google Search", kind: "gemini_google_search", sourceConnectionId: authority.connectionId } });
    const draft = { ...normalizeSearchDraft(builtInSearchDraft({ kind: "gemini_google_search", config: {} })) };
    const strategy = await prisma.searchStrategy.create({ data: { searchOptionId: option.id, strategyId: optionId,
      provider: "gemini", displayName: "Google Search", kind: "gemini_google_search", description: "Synthetic Search",
      config: {}, draft, adapterKind: "answer_provider_hosted", credentialMode: "answer_provider" } });
    const revision = await prisma.searchIntegrationRevision.create({ data: { searchStrategyId: strategy.id,
      revisionNumber: 1, adapterKind: "answer_provider_hosted", credentialMode: "answer_provider", configuration: draft,
      validationEvidence: { syntheticCatalogFixture: true }, draftHash: searchDraftHash(draft), validationFingerprint: id } });
    await prisma.searchStrategy.update({ where: { id: strategy.id }, data: { activeRevisionId: revision.id, activatedAt: new Date() } });
    await prisma.searchPolicy.update({ where: { id: "installation" }, data: { defaultPlan: google } });
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
    expect((await catalog()).defaults).toMatchObject({ searchPreferenceSource: "organization", searchPlan: google });
    await startNewChat(page);
    await expect(page.getByRole("button", { name: /^Choose web search/ })).toHaveAccessibleDescription("Search: Google");
    await prisma.searchPolicy.update({ where: { id: "installation" }, data: { defaultPlan: off } });
    await page.reload();
    await expect(page.getByRole("button", { name: /^Choose web search/ })).toHaveAccessibleDescription("Search: Off");
    expect((await catalog()).defaults).toMatchObject({ searchPreferenceSource: "organization", searchPlan: off });
    await prisma.searchPolicy.update({ where: { id: "installation" }, data: { defaultPlan: google } });
    await page.reload();
    await expect(page.getByRole("button", { name: /^Choose web search/ })).toHaveAccessibleDescription("Search: Google");
    const created = await page.request.post("/api/chats", { data: { title: "Saved Search choices" } });
    expect(created.ok()).toBe(true);
    const chatId = (await created.json()).chat.id;
    await page.goto(`/?chat=${chatId}`);
    await chooseSearchStrategy(page, "Off");
    await expect.poll(async () => (await prisma.chat.findUniqueOrThrow({ where: { id: chatId } })).defaultSearchPlan).toEqual(off);
    expect((await prisma.userSettings.findUniqueOrThrow({ where: { userId: id } })).defaultSearchPlan).toBeNull();
    await page.reload();
    await expect(page.getByRole("button", { name: /^Choose web search/ })).toHaveAccessibleDescription("Search: Off");
    await startNewChat(page);
    await expect(page.getByRole("button", { name: /^Choose web search/ })).toHaveAccessibleDescription("Search: Google");
    await runAccountMenuAction(page, "Chat defaults");
    let settings = page.getByTestId("library-v2");
    await settings.getByLabel("Web search default").click();
    await settings.getByRole("button", { name: "Turn off search" }).click();
    await expect.poll(async () => (await prisma.userSettings.findUniqueOrThrow({ where: { userId: id } })).defaultSearchPlan).toEqual(off);
    await page.goto("about:blank");
    await page.request.post("/api/auth/logout", { data: {} });
    await prisma.$transaction((tx) => provisionActiveUser(tx, { userId: id }));
    await loginWithPassword(page, user);
    await startNewChat(page);
    await expect(page.getByRole("button", { name: /^Choose web search/ })).toHaveAccessibleDescription("Search: Off");
    expect((await catalog()).defaults).toMatchObject({ searchPreferenceSource: "personal", searchPlan: off });
    await runAccountMenuAction(page, "Chat defaults");
    settings = page.getByTestId("library-v2");
    await settings.getByLabel("Web search default").click();
    await settings.getByRole("checkbox", { name: /Google Search/ }).check();
    await expect.poll(async () => (await prisma.userSettings.findUniqueOrThrow({ where: { userId: id } })).defaultSearchPlan).toEqual(google);
    await prisma.$transaction((tx) => provisionActiveUser(tx, { userId: id }));
    await settings.getByRole("button", { name: "Back to chat" }).click();
    await startNewChat(page);
    await expect(page.getByRole("button", { name: /^Choose web search/ })).toHaveAccessibleDescription("Search: Google");
    expect((await catalog()).defaults).toMatchObject({ searchPreferenceSource: "personal", searchPlan: google });
    await page.goto(`/?chat=${chatId}`);
    await expect(page.getByRole("button", { name: /^Choose web search/ })).toHaveAccessibleDescription("Search: Off");
    await runAccountMenuAction(page, "Chat defaults");
    settings = page.getByTestId("library-v2");
    await settings.getByLabel("Web search default").click();
    await settings.getByRole("button", { name: "Use organization Search default" }).click();
    await expect.poll(async () => (await catalog()).defaults.searchPreferenceSource).toBe("organization");

    const projectResponse = await page.request.post("/api/projects", {
      data: { name: `Search choices ${id}`, preferredModelId: model.id }
    });
    expect(projectResponse.status()).toBe(201);
    const project = (await projectResponse.json()).project;
    projectId = project.id;
    const resource = await page.request.post(`/api/projects/${project.id}/resources`, {
      data: { expectedPolicyRevision: project.policyRevision, resourceId: optionId, type: "search" }
    });
    expect(resource.status()).toBe(201);
    const projectChats: string[] = [];
    for (const title of ["Saved Project Search", "Other Project chat"]) {
      const response = await page.request.post(`/api/projects/${project.id}/chats`, { data: { title } });
      expect(response.status()).toBe(201);
      projectChats.push((await response.json()).chat.id);
    }
    expect((await page.request.patch(`/api/chats/${projectChats[0]}`, {
      data: { defaultSearchPlan: google }
    })).ok()).toBe(true);
    await page.goto("/");
    await expect(page.getByRole("button", { name: /^Choose web search/ })).toHaveAccessibleDescription("Search: Off");
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    const shared = page.locator('section[aria-label="Shared projects"]');
    await expect(shared).toBeVisible();
    await shared.locator(".v2-project-row").filter({ hasText: project.name }).click();
    const savedChat = shared.locator(".v2-project-chat-row").filter({ hasText: "Saved Project Search" });
    await savedChat.click();
    const searchChip = page.getByRole("button", { name: /^Choose web search/ });
    await expect(searchChip).toHaveAccessibleDescription("Search: Google");
    await chooseSearchStrategy(page, "Off");
    await expect.poll(async () => (await prisma.chat.findUniqueOrThrow({ where: { id: projectChats[0] } })).defaultSearchPlan).toEqual(off);
    await shared.locator(".v2-project-chat-row").filter({ hasText: "Other Project chat" }).click();
    await savedChat.click();
    await expect(searchChip).toHaveAccessibleDescription("Search: Off");
    await chooseSearchStrategy(page, "Google");
    await expect.poll(async () => (await prisma.chat.findUniqueOrThrow({ where: { id: projectChats[0] } })).defaultSearchPlan).toEqual(google);
    await shared.locator(".v2-project-chat-row").filter({ hasText: "Other Project chat" }).click();
    await expect(searchChip).toHaveAccessibleDescription("Search: Off");
    await savedChat.click();
    await expect(searchChip).toHaveAccessibleDescription("Search: Google");
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await searchChip.click();
      await expect(page.getByRole("dialog", { name: "Web search" }).getByRole("checkbox", { name: /Google Search/ })).toBeChecked();
      await page.screenshot({ path: testInfo.outputPath(`saved-project-search-${viewport.width}.png`) });
      await page.keyboard.press("Escape");
    }
    await prisma.userGroup.deleteMany({ where: { userId: id } });
    const restricted = await catalog();
    expect(restricted.searchStrategies.some((entry: { strategyId: string }) => entry.strategyId === optionId)).toBe(false);
    expect(await prisma.modelRun.count({ where: { userId: id } })).toBe(0);
  } finally {
    if (projectId) await prisma.project.deleteMany({ where: { id: projectId } });
    await prisma.user.deleteMany({ where: { id } });
    await prisma.searchPolicy.update({ where: { id: "installation" }, data: { defaultPlan: priorPolicy.defaultPlan as Prisma.InputJsonValue } });
    await prisma.searchStrategy.updateMany({ where: { strategyId: optionId }, data: { activeRevisionId: null } });
    await prisma.searchIntegrationRevision.deleteMany({ where: { searchStrategy: { strategyId: optionId } } });
    await prisma.searchStrategy.deleteMany({ where: { strategyId: optionId } });
    await prisma.searchOption.deleteMany({ where: { optionId } });
    await prisma.providerModelCredentialCheck.deleteMany({ where: { connectionId: authority.connectionId } });
    await deleteTestProviderExecutionAuthority(prisma, authority);
  }
});
