import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { SkillDetail, SkillImportResponse } from "../../lib/contracts/skills";
import { hashPassword } from "../../lib/server/auth/password";
import { provisionActiveUser } from "../../lib/server/auth/provisioning";
import { writeZip } from "../../lib/server/artifacts/zip";
import { runAccountMenuAction } from "./shell/page";
import { expectCenterUnobscured, expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";
import { loginWithPassword } from "./support/workspace";

test.use({ locale: "en-US", contextOptions: { reducedMotion: "reduce" } });
const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

async function openOwnerDetail(page: Page, name: string): Promise<Locator> {
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await runAccountMenuAction(page, "Assistants");
  await page.getByTestId("library-v2").getByRole("tab", { name: "Skill library", exact: true }).click();
  const library = page.getByTestId("skill-library-section");
  await library.getByRole("searchbox", { name: "Search Skills" }).fill(name);
  await library.getByRole("button", { name: `Open ${name}`, exact: true }).click();
  const detail = library.getByRole("region", { name: "Skill detail", exact: true });
  await expect(detail.getByRole("heading", { name, exact: true })).toBeVisible();
  return detail;
}

async function capture(page: Page, anchor: Locator, testInfo: TestInfo, surface: string) {
  for (const theme of ["light", "dark"]) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; document.documentElement.dataset.colorScheme = value; }, theme);
    for (const viewport of [{ width: 1440, height: 900 }, { width: 834, height: 1194 }, { width: 1194, height: 834 },
      { width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      await anchor.scrollIntoViewIfNeeded();
      await expectWithinViewport(page, anchor);
      await expectCenterUnobscured(anchor);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`skills-sharing-${surface}-${theme}-${viewport.width}x${viewport.height}.png`), animations: "disabled" });
    }
  }
}

test("Skill approval shares only reviewed content, preserves the approved revision after edits, and shows rejection and withdrawal", async ({ page: admin, browser, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const users = ["owner", "reader"].map(label => ({ id: randomUUID(), email: `skill-${label}-${randomUUID()}@example.test`,
    password: `Synthetic-${randomUUID()}`, displayName: `Skill ${label}` }));
  const userIds = users.map(user => user.id);
  const groupId = randomUUID(), groupName = `Review team ${groupId.slice(0, 8)}`;
  const name = `Invoice review ${randomUUID().slice(0, 8)}`;
  const ownerContext = await browser.newContext({ baseURL, reducedMotion: "reduce" });
  const readerContext = await browser.newContext({ baseURL, reducedMotion: "reduce" });
  const owner = await ownerContext.newPage(), reader = await readerContext.newPage();
  try {
    const fullAccess = await prisma.group.findUniqueOrThrow({ where: { systemRole: "full_access" }, select: { id: true } });
    await prisma.group.create({ data: { id: groupId, name: groupName } });
    for (const [index, user] of users.entries()) {
      await prisma.user.create({ data: { id: user.id, email: user.email, displayName: user.displayName, status: "active", authIdentities: { create: {
        normalizedEmail: user.email, provider: "password", providerAccountId: user.email,
        passwordHash: await hashPassword(user.password), emailVerifiedAt: new Date()
      } } } });
      await prisma.$transaction(tx => provisionActiveUser(tx, { userId: user.id, groups: [
        { groupId: fullAccess.id, role: "member" }, { groupId, role: index === 0 ? "manager" : "member" }
      ] }));
    }
    await loginWithPassword(owner, users[0]!);
    await loginWithPassword(reader, users[1]!);
    await signInWithLocalToken(admin);
    const instructions = "Check invoice totals against references/checklist.md.";
    const bundle = writeZip([
      { path: "SKILL.md", bytes: Buffer.from(`---\nname: ${JSON.stringify(name)}\ndescription: Check invoice totals and evidence.\n---\n${instructions}`) },
      { path: "references/checklist.md", bytes: Buffer.from("# Invoice checklist\n\nCheck the currency, dates and line totals.\n") },
      { path: "scripts/check.sh", bytes: Buffer.from("#!/bin/sh\nprintf 'synthetic check\\n'\n"), executable: true }
    ]);
    const imported = await owner.request.post("/api/me/skills/import", { multipart: { file: { name: "skill.zip", mimeType: "application/zip", buffer: bundle } } });
    expect(imported.ok()).toBe(true);
    const result = (await imported.json() as SkillImportResponse).results[0]!;
    expect(result.outcome).toBe("created");
    if (result.outcome === "failed") throw new Error("synthetic_skill_import_failed");
    const skillId = result.skillId;
    const ownerDetail = async () => {
      const response = await owner.request.get(`/api/me/skills/${skillId}`); expect(response.ok()).toBe(true);
      return (await response.json() as { skill: SkillDetail }).skill;
    };
    let detail = await openOwnerDetail(owner, name);
    await detail.getByRole("button", { name: groupName, exact: true }).click();
    await expect(detail.getByText("Awaiting approval · v1", { exact: true })).toBeVisible();
    expect((await reader.request.get(`/api/me/skills/${skillId}`)).status()).toBe(404);
    expect((await reader.request.get("/api/admin/skills/requests")).status()).toBe(403);
    const unapprovedList = await reader.request.get(`/api/me/skills?${new URLSearchParams({ q: name })}`);
    expect((await unapprovedList.json()).skills).toEqual([]);

    await admin.goto("/admin?section=skills&filter=pending");
    const section = admin.getByTestId("admin-skills-section");
    await section.getByRole("button", { name: `Review ${name} · v1`, exact: true }).click();
    await expect(section.getByLabel("Requested SKILL.md")).toContainText(instructions);
    await section.getByRole("button", { name: "View scripts/check.sh" }).click();
    await expect(section.locator('pre[aria-label="scripts/check.sh"]')).toContainText("synthetic check");
    await section.getByRole("textbox", { name: /Review note/ }).fill("Ready for the review team.");
    await capture(admin, section.getByRole("button", { name: "Approve v1", exact: true }), testInfo, "admin");
    await section.getByRole("button", { name: "Approve v1", exact: true }).click();
    await expect(section.getByText("Revision v1 approved.", { exact: true })).toBeVisible();
    const approvedRead = await reader.request.get(`/api/me/skills/${skillId}`);
    expect(approvedRead.ok()).toBe(true);
    expect((await approvedRead.json()).skill.instructions).toBe(instructions);

    const first = await ownerDetail();
    const revisedInstructions = `${instructions}\nEscalate unmatched totals to the owner.`;
    const revised = await owner.request.patch(`/api/me/skills/${skillId}`, { data: {
      expectedVersion: first.version, revision: { name, description: first.description, instructions: revisedInstructions }
    } });
    expect(revised.ok()).toBe(true);
    detail = await openOwnerDetail(owner, name);
    await expect(detail.getByText("Your version: v2. Approved for sharing: v1.", { exact: true })).toBeVisible();
    expect((await (await reader.request.get(`/api/me/skills/${skillId}`)).json()).skill.instructions).toBe(instructions);
    await detail.getByRole("button", { name: "Request approval for v2", exact: true }).click();
    await expect(detail.getByText("Awaiting approval · v2", { exact: true })).toBeVisible();
    await admin.goto("/admin?section=skills&filter=pending");
    await section.getByRole("button", { name: `Review ${name} · v2`, exact: true }).click();
    await expect(section.getByLabel("Requested SKILL.md")).toContainText("Escalate unmatched totals");
    await section.getByRole("textbox", { name: /Review note/ }).fill("Please clarify which limits apply.\nKeep the approved checklist.");
    await section.getByRole("button", { name: "Reject", exact: true }).click();
    await expect(section.getByText("Request rejected. The previous approved revision is unchanged.", { exact: true })).toBeVisible();
    detail = await openOwnerDetail(owner, name);
    await expect(detail.getByText("Changes requested · v2", { exact: true })).toBeVisible();
    await expect(detail.getByText(/Please clarify which limits apply/)).toBeVisible();
    await capture(owner, detail.getByRole("button", { name: "Request approval for v2", exact: true }), testInfo, "owner");
    await detail.getByRole("button", { name: "Request approval for v2", exact: true }).click();
    await expect(detail.getByText("Awaiting approval · v2", { exact: true })).toBeVisible();
    await detail.getByRole("button", { name: "Withdraw request", exact: true }).click();
    await expect(detail.getByText("Withdrawn · v2", { exact: true })).toBeVisible();
    expect((await (await reader.request.get(`/api/me/skills/${skillId}`)).json()).skill.instructions).toBe(instructions);
    expect((await ownerDetail()).sharing?.sharedRevision?.revisionNumber).toBe(1);
  } finally {
    await ownerContext.close(); await readerContext.close();
    // Only this test's synthetic users and their unreferenced Skill fixtures.
    await prisma.$transaction(async tx => {
      const where = { ownerUserId: { in: userIds } };
      const skillIds = (await tx.skillDefinition.findMany({ where, select: { id: true } })).map(skill => skill.id);
      await tx.skillPublication.deleteMany({ where: { skillId: { in: skillIds } } });
      await tx.skillShareRequest.deleteMany({ where: { skillId: { in: skillIds } } });
      await tx.skillDefinition.updateMany({ where, data: { currentRevisionId: null, sharedRevisionId: null } });
      await tx.skillRevisionFile.deleteMany({ where: { skillId: { in: skillIds } } });
      await tx.skillRevision.deleteMany({ where: { skillId: { in: skillIds } } });
      await tx.skillDefinition.deleteMany({ where });
      await tx.userGroup.deleteMany({ where: { userId: { in: userIds } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      await tx.group.deleteMany({ where: { id: groupId } });
    });
  }
});
