import { execFileSync } from "node:child_process";
import { Prisma, type PrismaClient } from "@prisma/client";
import { expect, type Page } from "@playwright/test";
import { chooseSearchStrategy, engageComposer } from "../shell/composer";
import { disableMemoryRecall } from "./workspace";

/**
 * A composer turn with as few tools as the composer offers, chosen through
 * its own chips: MCP off, Skills off and Search off (when the installation
 * offers Search), with Memory recall off. Workspace has no switch any more
 * (ambient since 2026-10-20): it joins every turn of a tool-calling model
 * while the installation offers it. On a real model this keeps a bounded
 * paid turn to one plain answer.
 *
 * The chips also save their choice as the account's chat defaults, so a spec
 * snapshots the defaults first and restores them afterwards.
 */
export async function turnComposerToolsOff(page: Page): Promise<void> {
  const mcp = page.getByRole("button", { name: "Change MCP mode" });
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({ timeout: 30_000 });
  await engageComposer(page);
  await expect(mcp).toBeVisible({ timeout: 30_000 });
  await disableMemoryRecall(page);
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
    if (memory) restoreMemoryToggles(userId, memory);
  };
}

type MemoryToggles = Readonly<{ learnAutomatically: boolean; referenceChatHistory: boolean; useMemoryFacts: boolean }>;

/** Through the product's settings repository, as the settings route patches
 * them: a resumed toggle closes its open MemoryPauseInterval, which a raw row
 * update would leave open and make the next pause fail its unique scope. The
 * repository runs in its own `tsx` process (`./restoreMemoryToggles.ts`). */
function restoreMemoryToggles(userId: string, memory: MemoryToggles): void {
  execFileSync(process.execPath, ["--import", "tsx", "tests/e2e/support/restoreMemoryToggles.ts", userId, JSON.stringify(memory)],
    { stdio: "pipe" });
}
