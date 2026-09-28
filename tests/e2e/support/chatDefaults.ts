import type { PrismaClient } from "@prisma/client";
import { expect, type APIRequestContext } from "@playwright/test";
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
