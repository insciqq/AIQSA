import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { hashPassword } from "../../lib/server/auth/password";
import { provisionActiveUser } from "../../lib/server/auth/provisioning";
import { runAccountMenuAction } from "./shell/page";

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());
const controls = [
  ["useMemoryFacts", "Use memories in answers"],
  ["referenceChatHistory", "Search past chats"],
  ["learnAutomatically", "Learn automatically"],
  ["synthesisEnabled", "Notice repeated details"],
  ["decayEnabled", "Learn from what you use"]
] as const;

async function login(page: Page, user: { email: string; password: string }) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByTestId("app-shell")).toBeVisible();
}

async function openMemory(page: Page) {
  await runAccountMenuAction(page, "Settings");
  const settings = page.getByTestId("settings-v2");
  await settings.getByRole("button", { name: "Memory", exact: true }).click();
  return settings;
}

test("new accounts start with all Memory controls on and later choices survive login and adoption", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const users = (["user", "admin"] as const).map((role) => ({
    id: randomUUID(), role, email: `memory-defaults-${randomUUID()}@example.test`, password: `Synthetic-${randomUUID()}`
  }));
  let preferenceWrites = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/me/memory/settings" && request.method() === "PATCH") preferenceWrites += 1;
  });
  try {
    for (const user of users) {
      await prisma.user.create({ data: { id: user.id, email: user.email, displayName: "Synthetic Memory owner", role: user.role,
        status: "active", authIdentities: { create: {
          normalizedEmail: user.email, provider: "password", providerAccountId: user.email,
          passwordHash: await hashPassword(user.password), emailVerifiedAt: new Date()
        } } } });
      await prisma.$transaction((tx) => provisionActiveUser(tx, { userId: user.id, groups: [] }));
      await login(page, user);
      const first = await page.request.get("/api/me/memory/settings");
      expect(first.ok()).toBe(true);
      expect((await first.json()).settings).toMatchObject(Object.fromEntries(controls.map(([key]) => [key, true])));
      expect(preferenceWrites).toBe(0);
      const settings = await openMemory(page);
      for (const [, label] of controls) await expect(settings.getByRole("switch", { name: new RegExp(`^${label}:`) })).toBeChecked();
      expect(preferenceWrites).toBe(0);
      await page.screenshot({ path: testInfo.outputPath(`memory-defaults-${user.role}.png`) });
      await page.goto("about:blank");
      await page.request.post("/api/auth/logout", { data: {} });
    }

    const user = users[0]!;
    await login(page, user);
    const settings = await openMemory(page);
    for (const [, label] of controls) {
      const control = settings.getByRole("switch", { name: new RegExp(`^${label}:`) });
      await expect(control).toBeEnabled();
      await control.click();
      await expect(control).not.toBeChecked();
    }
    const disabled = Object.fromEntries(controls.map(([key]) => [key, false]));
    await expect.poll(async () => (await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId: user.id } })).settingsRevision).toBe(5);
    expect(preferenceWrites).toBe(5);
    await page.reload();
    expect((await (await page.request.get("/api/me/memory/settings")).json()).settings).toMatchObject(disabled);
    await page.goto("about:blank");
    await page.request.post("/api/auth/logout", { data: {} });
    await prisma.$transaction((tx) => provisionActiveUser(tx, { userId: user.id, groups: [] }));
    await login(page, user);
    const reloaded = await openMemory(page);
    for (const [, label] of controls) await expect(reloaded.getByRole("switch", { name: new RegExp(`^${label}:`) })).not.toBeChecked();
    expect(preferenceWrites).toBe(5);
    expect(await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId: user.id } })).toMatchObject(disabled);
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: users.map(({ id }) => id) } } });
  }
});
