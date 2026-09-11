import { generateKeyPairSync, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { hashPassword } from "../../lib/server/auth/password";
import { provisionActiveUser } from "../../lib/server/auth/provisioning";
import { decryptWorkspaceSecret } from "../../lib/server/workspace/secrets/store";
import type { WorkspaceSecretSummary } from "../../lib/contracts/workspaceSecrets";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { loginWithPassword } from "./support/workspace";

const prisma = new PrismaClient();
test.describe.configure({ mode: "serial" });
test.afterAll(() => prisma.$disconnect());

async function openSecrets(page: Page) {
  const sidebar = page.getByRole("button", { name: "Open sidebar" });
  if (!(await page.getByRole("button", { name: "Account menu" }).isVisible())) await sidebar.click();
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Workspace secrets" }).click();
  await expect(page.getByTestId("workspace-secrets-panel").getByRole("button", { name: "Add secret" })).toBeEnabled();
}

for (const viewport of [{ width: 1280, height: 560, theme: "dark" }, { width: 390, height: 844, theme: "light" }] as const) {
  test(`personal secret CRUD, original bytes and error recovery at ${viewport.width}`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(15_000);
    const userId = randomUUID();
    const email = `workspace-secrets-${userId}@example.com`;
    const password = `Synthetic-${randomUUID()}`;
    await prisma.user.create({ data: { id: userId, email, displayName: "Workspace access test", status: "active", authIdentities: { create: {
      normalizedEmail: email, provider: "password", providerAccountId: email, passwordHash: await hashPassword(password), emailVerifiedAt: new Date()
    } } } });
    await prisma.$transaction((tx) => provisionActiveUser(tx, { userId }));
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
    const summaries = async () => {
      const response = await page.request.get("/api/me/workspace/secrets");
      expect(response.ok()).toBe(true);
      expect(response.headers()["cache-control"]).toContain("no-store");
      return (await response.json()).secrets as WorkspaceSecretSummary[];
    };
    const savedValues = () => prisma.workspaceSecret.findMany({ where: { userId }, include: { value: true }, orderBy: { createdAt: "asc" } });
    try {
      await page.setViewportSize(viewport);
      await page.context().addCookies([{ name: "aiqsa.theme", value: viewport.theme, url: testInfo.project.use.baseURL! }]);
      await loginWithPassword(page, { email, password });
      await openSecrets(page);
      const panel = page.getByTestId("workspace-secrets-panel");
      await expect(panel.getByText("No saved Workspace secrets.")).toBeVisible();
      const add = async (kind: string, name: string) => {
        await panel.getByRole("button", { name: "Add secret" }).click();
        await expect(panel.getByLabel("Name", { exact: true })).toBeFocused();
        await panel.getByLabel("Type", { exact: true }).selectOption(kind);
        await panel.getByLabel("Name", { exact: true }).fill(name);
      };
      const save = async (name: string) => {
        await panel.getByRole("button", { name: "Save secret", exact: true }).click();
        await expect(panel.getByRole("heading", { name, exact: true })).toBeFocused();
      };

      await add("ssh_key", "Personal Git key");
      await expect(panel.getByLabel("Host", { exact: true })).toHaveCount(0);
      await panel.getByLabel("Private SSH key", { exact: true }).fill("invalid synthetic key");
      await panel.getByRole("button", { name: "Save secret", exact: true }).click();
      await expect(panel.getByRole("alert")).toContainText("valid private SSH key");
      await expect(panel.getByLabel("Private SSH key", { exact: true })).toHaveValue("invalid synthetic key");
      const personal = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
      await panel.getByLabel("Private SSH key", { exact: true }).fill(personal);
      await save("Personal Git key");

      await add("ssh_key", "Work Git key");
      const protectedKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem", cipher: "aes-256-cbc", passphrase: "synthetic key passphrase" }).toString();
      await panel.getByLabel("Or upload a private key").setInputFiles({ name: "work-key.pem", mimeType: "application/octet-stream", buffer: Buffer.from(protectedKey) });
      await expect(panel.getByLabel("Private SSH key", { exact: true })).toHaveValue(protectedKey);
      await panel.getByLabel("Key passphrase (if encrypted)").fill("synthetic key passphrase");
      await save("Work Git key");

      await add("env", "API and Basic Auth");
      const token = "synthetic '\"$HOME`command`\nПривет";
      for (const [index, name, value] of [[1, "SERVICE_TOKEN", token], [2, "BASIC_LOGIN", "synthetic-login"], [3, "BASIC_PASSWORD", "synthetic-password"]] as const) {
        if (index > 1) await panel.getByRole("button", { name: "Add variable", exact: true }).click();
        await panel.getByLabel(`Variable name ${index}`, { exact: true }).fill(name);
        await panel.getByLabel(`Variable value ${index}`, { exact: true }).fill(value);
      }
      await page.getByRole("button", { name: "Close settings" }).click();
      const discard = page.getByRole("alertdialog", { name: "Unsaved Workspace secret" });
      await expect(discard).toBeVisible();
      await discard.getByRole("button", { name: "Keep editing" }).click();
      await expect(panel.getByLabel("Variable value 1", { exact: true })).toHaveValue(token);
      await panel.getByRole("button", { name: "Save secret" }).scrollIntoViewIfNeeded();
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`secrets-env-${viewport.width}-${viewport.theme}.png`) });
      await save("API and Basic Auth");

      await add("text", "Website instructions");
      const text = "Synthetic password instructions\nUse only the test account.\n```literal```";
      await panel.getByLabel("Secret text").fill(text);
      await save("Website instructions");
      await add("file", "Credentials file");
      const original = Buffer.from([0, 255, 13, 10, 96, 36, 92]);
      await panel.getByLabel("Original file").setInputFiles({ name: ".credentials.bin", mimeType: "application/octet-stream", buffer: original });
      await expect(panel.getByText(".credentials.bin", { exact: true })).toBeVisible();
      await expect(panel.getByRole("button", { name: "Save secret" })).toBeEnabled();
      await save("Credentials file");

      const before = await summaries();
      expect(before).toHaveLength(5);
      expect(JSON.stringify(before)).not.toMatch(/PRIVATE KEY|synthetic-password|payloadEnvelope|synthetic key passphrase|literal/);
      const values = (await savedValues()).map(({ value }) => decryptWorkspaceSecret(value, userId).value);
      expect(values).toContainEqual({ kind: "env", entries: [{ name: "SERVICE_TOKEN", value: token }, { name: "BASIC_LOGIN", value: "synthetic-login" }, { name: "BASIC_PASSWORD", value: "synthetic-password" }] });
      expect(values).toContainEqual({ kind: "file", originalName: ".credentials.bin", base64: original.toString("base64") });
      expect(values).toContainEqual({ kind: "text", text });

      await panel.getByRole("button", { name: "Edit Website instructions", exact: true }).click();
      await expect(panel.getByLabel("Secret text")).toHaveCount(0);
      await panel.getByLabel("Name", { exact: true }).fill("Renamed instructions");
      const stale = before.find(({ kind }) => kind === "text")!;
      const parallel = await page.request.post("/api/me/workspace/secrets", { data: { action: "update", id: stale.id, expectedVersionId: stale.versionId,
        name: stale.name, description: "Changed in another window", value: { action: "preserve" } } });
      expect(parallel.ok()).toBe(true);
      await panel.getByRole("button", { name: "Save secret", exact: true }).click();
      await expect(panel.getByRole("alert")).toContainText("another window");
      await expect(panel.getByLabel("Name", { exact: true })).toHaveValue("Renamed instructions");
      await panel.getByRole("button", { name: "Refresh", exact: true }).click();
      await save("Renamed instructions");
      expect(decryptWorkspaceSecret((await savedValues()).find(({ id }) => id === stale.id)!.value, userId).value).toEqual({ kind: "text", text });
      await panel.getByRole("button", { name: "Edit Renamed instructions", exact: true }).click();
      await panel.getByLabel("Replace saved value").check();
      await panel.getByLabel("Secret text").fill("synthetic replacement");
      await save("Renamed instructions");
      await page.getByRole("button", { name: "Close settings" }).click();
      await page.reload();
      await openSecrets(page);
      await expect(panel.getByRole("heading", { level: 4 })).toHaveCount(5);
      await panel.getByRole("heading", { name: "Work Git key", exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`secrets-saved-${viewport.width}-${viewport.theme}.png`) });
      await expectNoHorizontalOverflow(page);
      for (const secret of await summaries()) {
        await panel.getByRole("button", { name: `Delete ${secret.name}`, exact: true }).click();
        await panel.getByRole("button", { name: "Delete permanently", exact: true }).click();
        await expect(panel.getByRole("heading", { name: secret.name, exact: true })).toHaveCount(0);
        await expect(panel.getByRole("button", { name: "Add secret" })).toBeFocused();
      }
      expect(await summaries()).toEqual([]);
      expect(browserErrors).toEqual([
        "Failed to load resource: the server responded with a status of 400 (Bad Request)",
        "Failed to load resource: the server responded with a status of 409 (Conflict)"
      ]);
    } finally {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
}
