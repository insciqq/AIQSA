import type { PrismaClient } from "@prisma/client";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import type { ChatDefaultMcpMode } from "../../../lib/contracts/chatDefaults";
import { fakeModelId } from "./assistants";

/**
 * Chat defaults a sending spec needs on the fake-provider stand. The Fake QSA
 * model has an 8192-token window and the Workspace context of a default that
 * turns Workspace on does not fit it: the first message of a new chat then
 * answers 400 `context_too_large`. New users (the seeded operator and every
 * synthetic user) start with the Workspace default on.
 */

/** Sets the signed-in user's Workspace default; the next new chat uses it after a reload. */
export async function setWorkspaceDefault(request: APIRequestContext, enabled: boolean): Promise<void> {
  const response = await request.patch("/api/me/settings", { data: { defaultWorkspaceEnabled: enabled } });
  expect(response.ok(), await response.text()).toBe(true);
}

/** Gives a synthetic user the Fake QSA model and the Workspace default off, before they sign in. */
export async function prepareFakeQsaChats(prisma: PrismaClient, userId: string): Promise<void> {
  await prisma.userSettings.update({
    data: { defaultProviderModelId: await fakeModelId(prisma), defaultWorkspaceEnabled: false },
    where: { userId }
  });
}

const keptMcpDefaultPages = new WeakSet<Page>();

/**
 * The composer's MCP chip also saves its mode as the signed-in account's
 * default. A spec that picks a mode only for its own chats keeps the account's
 * saved default, so no later spec on a shared seeded account inherits it; the
 * composer still shows and sends the picked mode.
 */
export async function keepAccountMcpDefault(page: Page): Promise<void> {
  if (keptMcpDefaultPages.has(page)) return;
  keptMcpDefaultPages.add(page);
  await page.route("**/api/me/settings", async (route) => {
    const request = route.request();
    const body = request.method() === "PATCH" ? request.postDataJSON() as Record<string, unknown> | null : null;
    if (!body || !("defaultMcpMode" in body)) return route.fallback();
    const catalog = await page.request.get("/api/me/catalog");
    if (!catalog.ok()) throw new Error(`MCP default read failed: ${catalog.status()}`);
    const { defaults } = (await catalog.json() as { catalog: { defaults: { mcpMode?: ChatDefaultMcpMode } } }).catalog;
    await route.continue({ postData: JSON.stringify({ ...body, defaultMcpMode: defaults.mcpMode ?? "auto" }) });
  });
}
