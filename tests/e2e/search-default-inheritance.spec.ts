import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { hashPassword } from "../../lib/server/auth/password";
import { provisionActiveUser } from "../../lib/server/auth/provisioning";
import { builtInSearchDraft, normalizeSearchDraft, searchDraftHash } from "../../lib/server/search/configuration";
import { createTestProviderExecutionAuthority, deleteTestProviderExecutionAuthority } from "../support/providerExecutionAuthority";
import { loginWithPassword, startNewChat } from "./support/workspace";
import { runAccountMenuAction } from "./shell/page";

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

test("one Search default serves every chat across navigation, reload and login", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const id = randomUUID();
  const user = { email: `search-inheritance-${id}@example.test`, password: `Synthetic-${randomUUID()}` };
  const authority = await createTestProviderExecutionAuthority(prisma, "search-inheritance");
  const priorPolicy = await prisma.searchPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  const optionId = `search-inheritance-${id}`;
  const chosen = { mode: "all_selected", optionIds: [optionId] };
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
    const option = await prisma.searchOption.create({ data: { optionId, displayName: "OpenAI Search",
      description: "Synthetic catalog-only OpenAI Search", kind: "web_search", sourceConnectionId: authority.connectionId } });
    const draft = { ...normalizeSearchDraft(builtInSearchDraft({ kind: "web_search", config: {} })) };
    const strategy = await prisma.searchStrategy.create({ data: { searchOptionId: option.id, strategyId: optionId,
      provider: "openai", displayName: "OpenAI Search", kind: "web_search", description: "Synthetic Search",
      config: {}, draft, adapterKind: "answer_provider_hosted", credentialMode: "answer_provider" } });
    const revision = await prisma.searchIntegrationRevision.create({ data: { searchStrategyId: strategy.id,
      revisionNumber: 1, adapterKind: "answer_provider_hosted", credentialMode: "answer_provider", configuration: draft,
      validationEvidence: { syntheticCatalogFixture: true }, draftHash: searchDraftHash(draft), validationFingerprint: id } });
    await prisma.searchStrategy.update({ where: { id: strategy.id }, data: { activeRevisionId: revision.id, activatedAt: new Date() } });
    await prisma.searchPolicy.update({ where: { id: "installation" }, data: { defaultPlan: chosen } });
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
    // An organization default without a source is automatic, never Off
    // (operator decision 2026-10-24); with this fixture the only source.
    const expectAutomatic = async (where: string) => {
      const current = await catalog();
      expect(current.defaults.searchPreferenceSource, where).toBe("organization");
      expect(current.defaults.searchPlan.optionIds, where).toHaveLength(1);
      expect(current.defaults.organizationSearchPlan, where).toEqual(current.defaults.searchPlan);
      if (current.searchStrategies.filter((entry: { kind: string }) => entry.kind !== "none").length === 1) {
        expect(current.defaults.searchPlan, where).toEqual(chosen);
      }
      await expect(page.getByRole("button", { name: /^Choose web search/ }), where).toHaveAccessibleDescription(/^Search: (?!Off$)/u);
    };
    expect((await catalog()).defaults).toMatchObject({ searchPreferenceSource: "organization", searchPlan: chosen });
    await startNewChat(page);
    await expect(page.getByRole("button", { name: /^Choose web search/ })).toHaveAccessibleDescription("Search: OpenAI");
    await prisma.searchPolicy.update({ where: { id: "installation" }, data: { defaultPlan: off } });
    await page.reload();
    await expectAutomatic("organization default without a source");
    await prisma.searchPolicy.update({ where: { id: "installation" }, data: { defaultPlan: chosen } });
    await page.reload();
    await expect(page.getByRole("button", { name: /^Choose web search/ })).toHaveAccessibleDescription("Search: OpenAI");
    const created = await page.request.post("/api/chats", { data: { title: "Saved Search choices" } });
    expect(created.ok()).toBe(true);
    const chatId = (await created.json()).chat.id;
    // Chats keep no Search plan of their own (operator decision 2026-10-24):
    // one an older release saved on a chat is ignored.
    expect((await page.request.patch(`/api/chats/${chatId}`, { data: { defaultSearchPlan: off } })).ok()).toBe(true);
    const searchChip = page.getByRole("button", { name: /^Choose web search/ });
    const chipSource = page.getByRole("dialog", { name: "Web search" }).getByRole("checkbox", { name: /OpenAI Search/ });
    await page.goto(`/c/${chatId}`);
    await expect(searchChip).toHaveAccessibleDescription("Search: OpenAI");
    // The chip never turns Search off: its last source stays on.
    await searchChip.click();
    await expect(chipSource).toBeChecked();
    await expect(chipSource).toBeDisabled();
    await page.keyboard.press("Escape");

    // Off only in Chat defaults, after a confirmation, and for every chat.
    await runAccountMenuAction(page, "Chat defaults");
    let settings = page.getByTestId("library-v2");
    await settings.getByLabel("Web search default").click();
    const confirmation = page.getByRole("dialog", { name: "Turn off web search" });
    await settings.getByRole("button", { name: "Turn off web search" }).click();
    await expect(confirmation).toContainText("Answers will get worse.");
    await confirmation.getByRole("button", { name: "Keep search on" }).click();
    await expect(confirmation).toHaveCount(0);
    expect((await prisma.userSettings.findUniqueOrThrow({ where: { userId: id } })).defaultSearchPlan).toBeNull();
    await settings.getByRole("button", { name: "Turn off web search" }).click();
    await confirmation.getByRole("button", { name: "Confirm turn off" }).click();
    await expect.poll(async () => (await prisma.userSettings.findUniqueOrThrow({ where: { userId: id } })).defaultSearchPlan).toEqual(off);
    await expect(settings.getByLabel("Web search default")).toHaveText("Off");
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
    expect((await catalog()).defaults).toMatchObject({ searchPreferenceSource: "personal", searchPlan: off });

    // Checking a source in any chat's chip turns Search back on everywhere,
    // without a confirmation, and leaves the chat's own column untouched.
    await page.goto(`/c/${chatId}`);
    await expect(searchChip).toHaveAccessibleDescription("Search: Off");
    await searchChip.click();
    await chipSource.check();
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await prisma.userSettings.findUniqueOrThrow({ where: { userId: id } })).defaultSearchPlan).toEqual(chosen);
    expect((await prisma.chat.findUniqueOrThrow({ where: { id: chatId } })).defaultSearchPlan).toEqual(off);
    await expect(searchChip).toHaveAccessibleDescription("Search: OpenAI");
    await startNewChat(page);
    await expect(searchChip).toHaveAccessibleDescription("Search: OpenAI");
    expect((await catalog()).defaults).toMatchObject({ searchPreferenceSource: "personal", searchPlan: chosen });
    await runAccountMenuAction(page, "Chat defaults");
    settings = page.getByTestId("library-v2");
    await expect(settings.getByLabel("Web search default")).toHaveText("OpenAI Search");
    await settings.getByLabel("Web search default").click();
    await settings.getByRole("button", { name: "Use organization default" }).click();
    await expect.poll(async () => (await catalog()).defaults.searchPreferenceSource).toBe("organization");
    await settings.getByRole("button", { name: "Back to chat" }).click();

    // New and existing chats both follow the organization default now.
    for (const [plan, label] of [[off, null], [chosen, "OpenAI"]] as const) {
      await prisma.searchPolicy.update({ where: { id: "installation" }, data: { defaultPlan: plan } });
      await page.goto("/");
      if (label === null) {
        await expectAutomatic("new blank chat after the reset, automatic organization default");
        await page.goto(`/c/${chatId}`);
        await expectAutomatic("existing chat, automatic organization default");
        continue;
      }
      expect((await catalog()).defaults, `new blank chat after the reset, organization Search default ${label}`)
        .toMatchObject({ organizationSearchPlan: plan, searchPlan: plan, searchPreferenceSource: "organization" });
      await expect(searchChip).toHaveAccessibleDescription(`Search: ${label}`);
      await page.goto(`/c/${chatId}`);
      await expect(searchChip, `existing chat, organization Search default ${label}`).toHaveAccessibleDescription(`Search: ${label}`);
    }
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await searchChip.click();
      await expect(page.getByRole("dialog", { name: "Web search" }).getByRole("checkbox", { name: /OpenAI Search/ })).toBeChecked();
      await page.screenshot({ path: testInfo.outputPath(`saved-chat-search-${viewport.width}.png`) });
      await page.keyboard.press("Escape");
    }
    await prisma.userGroup.deleteMany({ where: { userId: id } });
    const restricted = await catalog();
    expect(restricted.searchStrategies.some((entry: { strategyId: string }) => entry.strategyId === optionId)).toBe(false);
    expect(await prisma.modelRun.count({ where: { userId: id } })).toBe(0);
  } finally {
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
