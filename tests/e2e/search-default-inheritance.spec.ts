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

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

test("first login inherits organization Search and a later personal Off survives login and provisioning", async ({ page }) => {
  test.setTimeout(90_000);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const id = randomUUID();
  const user = { email: `search-inheritance-${id}@example.test`, password: `Synthetic-${randomUUID()}` };
  const authority = await createTestProviderExecutionAuthority(prisma, "search-inheritance");
  const priorPolicy = await prisma.searchPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  const optionId = `search-inheritance-${id}`;
  const google = { mode: "all_selected", optionIds: [optionId] };
  const off = { mode: "all_selected", optionIds: [] };
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
    await expect(page.getByRole("button", { name: /^Choose web search/ })).toContainText("Search: Google");
    await expect(page.getByRole("button", { name: "Turn off Search" })).toBeVisible();
    await prisma.searchPolicy.update({ where: { id: "installation" }, data: { defaultPlan: off } });
    await page.reload();
    await expect(page.getByRole("button", { name: "Turn off Search" })).toHaveCount(0);
    expect((await catalog()).defaults).toMatchObject({ searchPreferenceSource: "organization", searchPlan: off });
    await prisma.searchPolicy.update({ where: { id: "installation" }, data: { defaultPlan: google } });
    await page.reload();
    await expect(page.getByRole("button", { name: "Turn off Search" })).toBeVisible();
    await chooseSearchStrategy(page, "Off");
    await expect.poll(async () => (await prisma.userSettings.findUniqueOrThrow({ where: { userId: id } })).defaultSearchPlan).toEqual(off);
    await page.goto("about:blank");
    await page.request.post("/api/auth/logout", { data: {} });
    await prisma.$transaction((tx) => provisionActiveUser(tx, { userId: id }));
    await loginWithPassword(page, user);
    await startNewChat(page);
    await expect(page.getByRole("button", { name: "Turn off Search" })).toHaveCount(0);
    expect((await catalog()).defaults).toMatchObject({ searchPreferenceSource: "personal", searchPlan: off });
    await chooseSearchStrategy(page, "Google");
    await expect.poll(async () => (await prisma.userSettings.findUniqueOrThrow({ where: { userId: id } })).defaultSearchPlan).toEqual(google);
    await prisma.$transaction((tx) => provisionActiveUser(tx, { userId: id }));
    await page.reload();
    await expect(page.getByRole("button", { name: "Turn off Search" })).toBeVisible();
    expect((await catalog()).defaults).toMatchObject({ searchPreferenceSource: "personal", searchPlan: google });
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
