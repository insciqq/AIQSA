import { existsSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import type { AssistantListResponse } from "../../lib/contracts/assistants";
import { createAssistantFixture, fakeModelId } from "./support/assistants";
import { CAPTURE_SIZES, CAPTURE_THEMES, captureState } from "./support/capture";
import { createPeopleFixture } from "./support/people";

/**
 * Self-check of the shared support helpers against the seeded stand: every
 * helper runs once and cleanup leaves none of its rows behind. Product
 * behaviour belongs to the feature specs.
 */

test.use({ locale: "en-US", contextOptions: { reducedMotion: "reduce" } });
const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

test("support helpers create people, Assistants and captures, then remove what they created", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const people = createPeopleFixture(prisma);
  const assistants = createAssistantFixture(prisma, { suffix: people.suffix });
  const userIds: string[] = [];
  const assistantIds: string[] = [];
  const chatIds: string[] = [];
  let groupId = "";
  try {
    const group = await people.group("Helpers team");
    groupId = group.id;
    const owner = await people.user("Owner", { groups: [{ group, role: "manager" }] });
    const reader = await people.user("Reader", { groups: [group] });
    const admin = await people.admin("Admin");
    userIds.push(owner.id, reader.id, admin.id);
    const ownerApi = (await people.signIn(browser, owner)).page.request;
    const readerPage = (await people.signIn(browser, reader)).page;
    const adminApi = (await people.signIn(browser, admin)).page.request;

    const modelId = await fakeModelId(prisma);
    const shared = await assistants.create(ownerApi, {
      name: "Helper check",
      rows: {
        model: { policy: "adjustable", value: { mode: "model", modelId } },
        search: { policy: "adjustable", value: { mode: "inherit" } }
      },
      starterPrompts: ["Summarize the open items"]
    });
    const seeded = await assistants.seed(owner.id, {
      name: "Seeded inherit",
      rows: { model: { policy: "adjustable", value: { mode: "inherit" } } }
    });
    const doomed = await assistants.create(ownerApi, { name: "Deleted helper" });
    assistantIds.push(shared.id, seeded.id, doomed.id);
    expect(shared.name).toBe(`Helper check ${people.suffix}`);

    await assistants.publish(ownerApi, shared.id, { groupId: group.id });
    const readerList = await readerPage.request.get("/api/me/assistants");
    expect(readerList.ok()).toBe(true);
    expect((await readerList.json() as AssistantListResponse).assistants.map((item) => item.id)).toContain(shared.id);
    expect((await ownerApi.get(`/api/me/assistants/${seeded.id}`)).status()).toBe(200);

    const { requestId } = await assistants.requestListing(ownerApi, shared.id);
    await assistants.decideListing(adminApi, requestId, "approve");
    await assistants.feature(adminApi, shared.id, 0);
    await assistants.feature(adminApi, shared.id, null);
    const outdatedId = await assistants.seedListingRequest({ assistantId: seeded.id, outdated: true });
    const outdated = await prisma.assistantListingRequest.findUniqueOrThrow({
      select: { assistant: { select: { version: true } }, definitionVersion: true },
      where: { id: outdatedId }
    });
    expect(outdated.assistant.version).toBe(outdated.definitionVersion + 1);
    await assistants.seedPublication(seeded.id, { groupId: group.id });

    await assistants.pin(readerPage.request, shared.id);
    const chatId = await assistants.createChat(readerPage.request, { assistant: { assistantId: shared.id } });
    chatIds.push(chatId);
    expect((await prisma.chat.findUniqueOrThrow({ select: { assistantId: true }, where: { id: chatId } })).assistantId)
      .toBe(shared.id);
    await assistants.archive(ownerApi, seeded.id);
    await assistants.archive(ownerApi, seeded.id, false);
    await assistants.remove(ownerApi, doomed.id);
    expect((await ownerApi.get(`/api/me/assistants/${doomed.id}`)).status()).toBe(404);

    const viewport = readerPage.viewportSize();
    const theme = await readerPage.evaluate(() => document.documentElement.getAttribute("data-theme"));
    const shots = await captureState(readerPage, testInfo, "support-helpers-new-chat");
    expect(shots).toHaveLength(CAPTURE_SIZES.length * CAPTURE_THEMES.length);
    expect(shots.every((shot) => existsSync(shot.path))).toBe(true);
    expect(readerPage.viewportSize()).toEqual(viewport);
    await expect.poll(() => readerPage.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe(theme);
  } finally {
    try {
      await assistants.cleanup();
    } finally {
      await people.cleanup();
    }
  }

  await expect(prisma.user.count({ where: { id: { in: userIds } } })).resolves.toBe(0);
  await expect(prisma.group.count({ where: { id: groupId } })).resolves.toBe(0);
  await expect(prisma.assistantDefinition.count({ where: { id: { in: assistantIds } } })).resolves.toBe(0);
  await expect(prisma.assistantPublication.count({ where: { assistantId: { in: assistantIds } } })).resolves.toBe(0);
  await expect(prisma.assistantListingRequest.count({ where: { assistantId: { in: assistantIds } } })).resolves.toBe(0);
  await expect(prisma.chat.count({ where: { id: { in: chatIds } } })).resolves.toBe(0);
});
