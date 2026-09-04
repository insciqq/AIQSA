import { expect, type Download, type Page } from "@playwright/test";
import { providerTemplateIds } from "../../../lib/domain/providerTemplates";
import { selectModel } from "../shell/composer";

/** Shared browser steps for the deterministic and live Workspace specs. */

export async function loginWithPassword(
  page: Page,
  user: Readonly<{ email: string; password: string }>
): Promise<void> {
  await page.addInitScript(() => {
    const key = "aiqsa.workspace.e2e.cleared";
    if (window.sessionStorage.getItem(key) === "1") return;
    window.localStorage.removeItem("aiqsa.activeChatId");
    window.sessionStorage.setItem(key, "1");
  });
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
}

export async function selectFakeModel(page: Page): Promise<void> {
  await selectModel(page, providerTemplateIds.fakeConnection, "Fake QSA", "Fake QSA");
  await expect(page.getByTestId("header-model-trigger")).toContainText("Fake QSA");
}

export async function startNewChat(page: Page): Promise<void> {
  await page.getByRole("complementary", { name: "Chat navigation" })
    .getByRole("button", { name: "New chat", exact: true })
    .click();
}

export async function turnWorkspaceOn(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: /^Turn on Workspace/u });
  await expect(toggle).toBeEnabled({ timeout: 15_000 });
  await toggle.click();
  await expect(page.getByRole("button", { name: /^Turn off Workspace/u })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
}

export async function activeChatId(page: Page): Promise<string> {
  let value: string | null = null;
  await expect.poll(async () => {
    value = await page.evaluate(() => window.localStorage.getItem("aiqsa.activeChatId"));
    return value;
  }, { timeout: 30_000 }).not.toBeNull();
  return value!;
}

export async function sendAndExpect(
  page: Page,
  prompt: string,
  answer: string,
  timeout = 45_000
): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(prompt);
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.locator('article[data-role="assistant"]').last()).toContainText(answer, {
    timeout
  });
  await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, {
    timeout: 45_000
  });
}

/** Sends a prompt whose scripted turn holds the run open, then presses Stop once it is stoppable. */
export async function sendAndStop(
  page: Page,
  prompt: string,
  beforeStop: (page: Page) => Promise<void> = async () => undefined
): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(prompt);
  await composer.press("Enter");
  const stop = page.getByRole("button", { name: "Stop answer" });
  await expect(stop).toBeEnabled({ timeout: 15_000 });
  await beforeStop(page);
  await stop.click();
  await expect(stop).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('article[data-role="assistant"]').last()).toContainText("Stopped");
}

export async function bytesFromDownload(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error("workspace_download_stream_unavailable");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export function lastAnswer(page: Page) {
  return page.locator('article[data-role="assistant"]').last();
}

export function lastActivity(page: Page) {
  return page.getByTestId("tool-activity-disclosure").last();
}

export async function openLastActivity(page: Page) {
  const activity = lastActivity(page);
  if (!(await activity.getAttribute("open"))) await activity.locator("summary").click();
  await expect(activity).toHaveAttribute("open", "");
  return activity;
}

export const RAW_WORKSPACE_IDENTIFIERS = /sandbox_(?:shell|exec|fs_)|mcp_workspace_|execSessionId|Used Workspace/u;
