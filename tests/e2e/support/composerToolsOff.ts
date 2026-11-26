import { Prisma, type PrismaClient } from "@prisma/client";
import { expect, type Page } from "@playwright/test";
import { chooseSearchStrategy, engageComposer } from "../shell/composer";
import { disableMemoryRecall } from "./workspace";

/**
 * A composer turn with as few tools as the composer offers, chosen through
 * its own chips: MCP off, Skills off and Search off (when the installation
 * offers Search), with Memory off. Workspace has no switch any more
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
  const search = page.getByRole("button", { name: "Web search", exact: true });
  if (await search.isVisible() && await search.getAttribute("data-search-state") !== "off") await chooseSearchStrategy(page, "Off");
}

/** Reads the account's chat defaults (model included) and Memory switches; the returned function restores them. */
export async function snapshotComposerDefaults(prisma: PrismaClient, userId: string): Promise<() => Promise<void>> {
  // The Memory switches are plain columns of the same row, restored with the defaults.
  const settings = await prisma.userSettings.findUnique({ where: { userId }, select: {
    defaultMcpMode: true, defaultProviderModelId: true, defaultSearchPlan: true, defaultSkillsMode: true, defaultWorkspaceEnabled: true,
    memoryEnabled: true, memorySuggestionsEnabled: true, pastChatSearchEnabled: true
  } });
  return async () => {
    if (settings) {
      await prisma.userSettings.update({ where: { userId }, data: {
        ...settings,
        defaultSearchPlan: settings.defaultSearchPlan === null ? Prisma.DbNull : settings.defaultSearchPlan as Prisma.InputJsonValue
      } });
    }
  };
}
