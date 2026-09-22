import { expect, test } from "@playwright/test";
import { LOCAL_OPERATOR_EMAIL, LOCAL_OPERATOR_PASSWORD } from "../../prisma/local-seed-auth";
import { runAccountMenuAction } from "./shell/page";
import { selectFakeModel, sendAndExpect, startNewChat } from "./support/workspace";

// Resolve a non-localhost origin to the disposable stand without granting it
// secure-context privileges. The browser must really lack randomUUID.
test.use({ launchOptions: { args: ["--host-resolver-rules=MAP app 127.0.0.1"] } });

test("chat actions and Workspace secrets work on a real insecure HTTP origin", async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  const origin = new URL(baseURL!);
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto(new URL("/login", origin).toString());
  expect(await page.evaluate(() => ({
    secure: window.isSecureContext,
    randomUUID: typeof crypto.randomUUID,
    getRandomValues: typeof crypto.getRandomValues
  }))).toEqual({ secure: false, randomUUID: "undefined", getRandomValues: "function" });

  // A cold dev server can display the form before its event handlers hydrate.
  await expect(async () => {
    await page.getByRole("button", { name: "Show password", exact: true }).click();
    await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("type", "text");
  }).toPass({ timeout: 15_000 });
  await page.getByRole("button", { name: "Hide password", exact: true }).click();
  await page.getByLabel("Email").fill(LOCAL_OPERATOR_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(LOCAL_OPERATOR_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
  const memorySettingsStatus = await page.evaluate(async () => {
    const response = await fetch("/api/me/memory/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ learnAutomatically: false, referenceChatHistory: false, useMemoryFacts: false })
    });
    return response.status;
  });
  expect(memorySettingsStatus).toBe(200);
  await startNewChat(page);
  await selectFakeModel(page);
  await sendAndExpect(page, "HTTP first message", "Fake answer: HTTP first message");
  await sendAndExpect(page, "HTTP follow-up", "Fake answer: HTTP follow-up");
  await page.reload();
  await expect(page.locator('article[data-role="assistant"]').last()).toContainText("Fake answer: HTTP follow-up", { timeout: 30_000 });

  await runAccountMenuAction(page, "Secrets");
  const secrets = page.getByTestId("workspace-secrets-panel");
  const sheet = page.getByTestId("workspace-secret-sheet");
  await expect(secrets.getByRole("button", { name: "Add secret" })).toBeEnabled({ timeout: 30_000 });
  await secrets.getByRole("button", { name: "Add secret" }).click();
  await sheet.getByRole("radio", { name: "Environment", exact: true }).check();
  await sheet.getByLabel("Name", { exact: true }).fill("HTTP fixture variables");
  await sheet.getByLabel("Variable name 1", { exact: true }).fill("HTTP_FIXTURE_ONE");
  await sheet.getByLabel("Variable value 1", { exact: true }).fill("synthetic-one");
  await sheet.getByRole("button", { name: "Add variable", exact: true }).click();
  await sheet.getByLabel("Variable name 2", { exact: true }).fill("HTTP_FIXTURE_TWO");
  await sheet.getByLabel("Variable value 2", { exact: true }).fill("synthetic-two");
  await sheet.getByRole("button", { name: "Save secret", exact: true }).click();
  await expect(secrets.getByRole("heading", { name: "HTTP fixture variables", exact: true })).toBeVisible();
  await secrets.getByRole("button", { name: "More actions for HTTP fixture variables", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await secrets.getByRole("button", { name: "Delete permanently", exact: true }).click();
  await expect(secrets.getByRole("heading", { name: "HTTP fixture variables", exact: true })).toHaveCount(0);
  expect(browserErrors).toEqual([]);
});
