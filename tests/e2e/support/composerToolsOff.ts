import { Prisma, type PrismaClient } from "@prisma/client";
import { expect, type Page } from "@playwright/test";
import { chooseSearchStrategy } from "../shell/composer";
import { disableMemoryRecall, setWorkspaceEnabled } from "./workspace";

/**
 * A composer turn without tools, chosen through the composer's own chips:
 * Workspace off, MCP off, Skills off and Search off (when the installation
 * offers Search), with Memory recall off. On the stand's 8k Fake QSA model
 * the Workspace tool surface beside the fixed prompt otherwise ends the turn
 * in 400 `context_too_large`; on a real model it keeps a bounded paid turn to
 * one plain answer.
 *
 * The chips also save their choice as the account's chat defaults, so a spec
 * snapshots the defaults first and restores them afterwards.
 */
export async function turnComposerToolsOff(page: Page): Promise<void> {
  const mcp = page.getByRole("button", { name: "Change MCP mode" });
  await expect(mcp).toBeVisible({ timeout: 30_000 });
  await disableMemoryRecall(page);
  if (await page.getByRole("button", { name: /^Workspace details\./u }).isVisible()) await setWorkspaceEnabled(page, false);
  if (await mcp.getAttribute("data-mcp-mode") !== "off") {
    await mcp.click();
    await page.getByRole("menu", { name: "MCP tools" }).getByRole("menuitemradio", { name: /^Off/u }).click();
  }
  await expect(mcp).toHaveAttribute("data-mcp-mode", "off");
  const skills = page.getByRole("button", { name: "Change Skills mode" });
  if (await skills.getAttribute("data-skills-mode") !== "off") {
    await skills.click();
    await page.getByRole("menu", { name: "Skills" }).getByRole("menuitemradio", { name: /^Off/u }).click();
  }
  await expect(skills).toHaveAttribute("data-skills-mode", "off");
  const search = page.getByRole("button", { name: /^Choose web search/u });
  if (await search.isVisible() && await search.getAttribute("data-quiet") === null) await chooseSearchStrategy(page, "Off");
}

/** Reads the account's chat defaults (model included) and Memory recall; the returned function restores them. */
export async function snapshotComposerDefaults(prisma: PrismaClient, userId: string): Promise<() => Promise<void>> {
  const settings = await prisma.userSettings.findUnique({ where: { userId }, select: {
    defaultMcpMode: true, defaultProviderModelId: true, defaultSearchPlan: true, defaultSkillsMode: true, defaultWorkspaceEnabled: true
  } });
  const memory = await prisma.userMemorySettings.findUnique({ where: { userId }, select: {
    learnAutomatically: true, referenceChatHistory: true, useMemoryFacts: true
  } });
  return async () => {
    if (settings) {
      await prisma.userSettings.update({ where: { userId }, data: {
        ...settings,
        defaultSearchPlan: settings.defaultSearchPlan === null ? Prisma.DbNull : settings.defaultSearchPlan as Prisma.InputJsonValue
      } });
    }
    if (memory) await restoreMemoryToggles(prisma, userId, memory);
  };
}

type MemoryToggles = Readonly<{ learnAutomatically: boolean; referenceChatHistory: boolean; useMemoryFacts: boolean }>;

/** Through the product's settings repository, as the settings route patches
 * them: a resumed toggle closes its open MemoryPauseInterval, which a raw row
 * update would leave open and make the next pause fail its unique scope. */
async function restoreMemoryToggles(prisma: PrismaClient, userId: string, memory: MemoryToggles): Promise<void> {
  const { createPrismaMemorySettingsRepository } = await import("../../../lib/server/memory/persistence/settings");
  const settings = createPrismaMemorySettingsRepository(prisma);
  const current = await settings.get(userId);
  if (current.learnAutomatically === memory.learnAutomatically && current.referenceChatHistory === memory.referenceChatHistory &&
    current.useMemoryFacts === memory.useMemoryFacts) return;
  // Unchanged toggles in the patch open or close nothing.
  await settings.patch(userId, {
    expectedMemoryRevision: current.memoryRevision, expectedSettingsRevision: current.settingsRevision,
    learnAutomatically: memory.learnAutomatically, referenceChatHistory: memory.referenceChatHistory, useMemoryFacts: memory.useMemoryFacts
  });
}
