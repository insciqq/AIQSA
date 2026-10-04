import { expect, test, type Page } from "@playwright/test";
import { providerTemplateIds } from "../../lib/domain/providerTemplates";
import { chooseSearchStrategy, selectModel } from "./shell/composer";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";

// The fake provider asks for one page through the real server pipeline; both
// links are refused before any network request (loopback, and a link the chat
// never contained), so the run is deterministic and offline.
test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);

const titlePrefix = "E2E page reader";

type WorkspaceBody = { chats: { id: string; title: string }[] };

async function signIn(page: Page) {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  const response = await page.request.post("/api/auth/token", { data: { token: "aiqsa-test-token" } });
  expect(response.ok()).toBe(true);
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();
}

async function cleanupPageReaderChats(page: Page) {
  const response = await page.request.get("/api/chats");
  if (!response.ok()) return;
  const body = (await response.json()) as WorkspaceBody;
  for (const chat of body.chats.filter((candidate) => candidate.title.startsWith(titlePrefix))) {
    await deleteOwnedChatPermanently(page.request, chat.id);
  }
}

async function prepareFakeBlankChat(page: Page) {
  await page.getByRole("complementary", { name: "Chat navigation" }).getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page.getByTestId("conversation-empty")).toBeVisible();
  await selectModel(page, providerTemplateIds.fakeConnection, "Fake QSA", "Fake QSA");
  if (await page.getByRole("button", { name: /^Choose web search/u }).isVisible()) await chooseSearchStrategy(page, "Off");
}

async function ask(page: Page, text: string, answer: string) {
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(text);
  await composer.press("Enter");
  await expect(page.getByTestId("conversation-thread")).toContainText(answer);
  await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0);
}

/** The newest answer's process steps, opened. */
async function latestSteps(page: Page) {
  const disclosure = page.getByTestId("tool-activity-disclosure").last();
  await expect(disclosure).toBeVisible();
  if (!(await disclosure.evaluate((element) => (element as HTMLDetailsElement).open))) await disclosure.locator("summary").click();
  return disclosure.locator(".v2-answer-process-step-name");
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await cleanupPageReaderChats(page);
  await page.reload();
  await expect(page.getByTestId("app-shell")).toBeVisible();
});

test.afterEach(async ({ page }) => {
  await cleanupPageReaderChats(page);
});

test("shows the page read's host/path with plain-language refusal copy", async ({ page }) => {
  await prepareFakeBlankChat(page);

  // A link the user wrote is authorized, but a loopback address is never read.
  await ask(page, `${titlePrefix}: read http://127.0.0.1/e2e-page?token=private [AIQSA_FETCH_URL_E2E:first_link]`,
    "Page reading finished: fetch_blocked_address.");
  const blocked = await latestSteps(page);
  await expect(blocked).toHaveText(["Blocked 127.0.0.1/e2e-page: this address is not allowed"]);
  await expect(page.getByTestId("tool-activity-disclosure").last()).not.toContainText("token=private");

  // A link the chat never contained is refused, and the model is told to ask for it.
  await ask(page, `${titlePrefix}: summarize the private page [AIQSA_FETCH_URL_E2E:unlisted]`,
    "Page reading finished: fetch_url_not_in_conversation.");
  const refused = await latestSteps(page);
  await expect(refused).toHaveText(["Didn't read unlisted.example/private: the link wasn't shared in this chat"]);

  // The persisted projection shows the same rows after a reload.
  await page.reload();
  await expect(page.getByTestId("conversation-thread")).toContainText("Page reading finished: fetch_url_not_in_conversation.");
  await expect(await latestSteps(page)).toHaveText(["Didn't read unlisted.example/private: the link wasn't shared in this chat"]);
});
