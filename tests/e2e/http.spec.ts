import { expect, test } from "@playwright/test";
import { LOCAL_OPERATOR_EMAIL, LOCAL_OPERATOR_PASSWORD } from "../../prisma/local-seed-auth";
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
  await expect(page.locator('article[data-role="assistant"]').last()).toContainText("Fake answer: HTTP follow-up");

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Workspace secrets" }).click();
  const secrets = page.getByTestId("workspace-secrets-panel");
  await secrets.getByRole("button", { name: "Add secret" }).click();
  await secrets.getByLabel("Type", { exact: true }).selectOption("env");
  await secrets.getByLabel("Name", { exact: true }).fill("HTTP fixture variables");
  await secrets.getByLabel("Variable name 1", { exact: true }).fill("HTTP_FIXTURE_ONE");
  await secrets.getByLabel("Variable value 1", { exact: true }).fill("synthetic-one");
  await secrets.getByRole("button", { name: "Add variable", exact: true }).click();
  await secrets.getByLabel("Variable name 2", { exact: true }).fill("HTTP_FIXTURE_TWO");
  await secrets.getByLabel("Variable value 2", { exact: true }).fill("synthetic-two");
  await secrets.getByRole("button", { name: "Save secret", exact: true }).click();
  await expect(secrets.getByRole("heading", { name: "HTTP fixture variables", exact: true })).toBeVisible();
  await secrets.getByRole("button", { name: "Delete HTTP fixture variables", exact: true }).click();
  await secrets.getByRole("button", { name: "Delete permanently", exact: true }).click();
  await expect(secrets.getByRole("heading", { name: "HTTP fixture variables", exact: true })).toHaveCount(0);
  expect(browserErrors).toEqual([]);
});
