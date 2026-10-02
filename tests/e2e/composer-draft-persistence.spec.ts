import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { providerTemplateIds } from "../../lib/domain/providerTemplates";
import { LOCAL_RESTRICTED_MEMBER } from "../../prisma/local-seed-fixtures";
import { chooseSearchStrategy } from "./shell/composer";
import { runAccountMenuAction } from "./shell/page";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { authenticateWithLocalToken, signInWithLocalToken } from "./support/localAuth";
import { selectFakeModel, setWorkspaceEnabled, submitPasswordSignIn } from "./support/workspace";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";

function composer(page: Page) { return page.getByRole("textbox", { name: "Message", exact: true }); }
async function storedText(page: Page) {
  return page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("aiqsa.composerDrafts.v1:"))
    .flatMap(key => (JSON.parse(localStorage.getItem(key)!) as { records: { draft: string }[] }).records.map(record => record.draft)));
}
async function prepareSend(page: Page) {
  await selectFakeModel(page);
  if (await page.getByRole("button", { name: /^Workspace details\./u }).isVisible()) await setWorkspaceEnabled(page, false);
  if (await page.getByRole("button", { name: /^Choose web search/u }).isVisible()) await chooseSearchStrategy(page, "Off");
}
/** Sends `source` to the fake model, then saves `comment` on the sent message's text. */
async function sendAndCommentOnMessage(page: Page, source: string, comment: string) {
  await prepareSend(page);
  await composer(page).fill(source);
  await composer(page).press("Enter");
  await expect(page.locator('article[data-role="assistant"]').last()).toContainText(`Fake answer: ${source}`, { timeout: 45_000 });
  await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 45_000 });
  const fragment = page.locator('article[data-role="user"] .v2-conversation-markdown').last();
  await fragment.scrollIntoViewIfNeeded();
  await fragment.evaluate(async element => {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Add comment", exact: true });
  await form.getByRole("textbox", { name: "Comment", exact: true }).fill(comment);
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "1 comment", exact: true })).toBeVisible();
}

test("reload preserves independently scoped drafts and the last tab write, while send admission clears them", async ({ page, context }, testInfo) => {
  test.setTimeout(300_000);
  await signInWithLocalToken(page);
  const suffix = randomUUID().slice(0, 8);
  const chatIds: string[] = [];
  let projectId: string | undefined;
  let second: Page | undefined;
  try {
    await composer(page).fill("Unsent new-chat text");
    // Reload immediately, before the debounce, exercising the pagehide flush.
    await page.reload();
    await expect(composer(page)).toHaveValue("Unsent new-chat text");
    await expect(composer(page)).not.toBeFocused();
    for (const title of ["First", "Second"]) {
      const response = await page.request.post("/api/chats", { data: { title: `${title} draft ${suffix}`, memoryMode: "EXCLUDED" } });
      expect(response.status()).toBe(201);
      chatIds.push((await response.json()).chat.id);
    }
    for (const [index, id] of chatIds.entries()) {
      await page.goto(`/c/${id}`);
      await expect(page.getByTestId("header-title")).toContainText(index ? "Second draft" : "First draft");
      await expect(composer(page)).toBeVisible({ timeout: 30_000 });
      await expect(composer(page)).toHaveValue("", { timeout: 30_000 });
      await composer(page).fill(`Saved-chat draft ${index}`);
      await page.reload();
      await expect(composer(page)).toHaveValue(`Saved-chat draft ${index}`);
    }
    await page.goto(`/c/${chatIds[0]}`);
    await expect(composer(page)).toHaveValue("Saved-chat draft 0", { timeout: 30_000 });
    second = await context.newPage();
    await second.goto(`/c/${chatIds[0]}`);
    await expect(composer(second)).toHaveValue("Saved-chat draft 0", { timeout: 30_000 });
    await composer(second).fill("Last tab write");
    await expect.poll(() => storedText(second!)).toContain("Last tab write");
    await expect(composer(page)).toHaveValue("Saved-chat draft 0");
    await page.reload();
    await expect(composer(page)).toHaveValue("Last tab write", { timeout: 30_000 });
    await second.close();
    second = undefined;

    const created = await page.request.post("/api/projects", { data: { name: `Draft Project ${suffix}`, preferredModelId: providerTemplateIds.fakeModel } });
    expect(created.status()).toBe(201);
    projectId = (await created.json()).project.id;
    await page.goto(`/p/${projectId}`);
    await expect(page.getByRole("complementary", { name: "Shared project context" })).toContainText(`Draft Project ${suffix}`, { timeout: 30_000 });
    await expect(composer(page)).toBeVisible({ timeout: 30_000 });
    await expect(composer(page)).toHaveValue("", { timeout: 30_000 });
    await composer(page).fill("Unsent Project text");
    await page.reload();
    await expect(composer(page)).toHaveValue("Unsent Project text", { timeout: 30_000 });
    await page.goto("/");
    await expect(composer(page)).toHaveValue("Unsent new-chat text", { timeout: 30_000 });

    await page.goto(`/c/${chatIds[0]}`);
    await prepareSend(page);
    const rejectedPath = `**/api/chats/${chatIds[0]}/messages`;
    await page.route(rejectedPath, route => route.fulfill({ status: 409, json: { error: "model_unavailable" } }), { times: 1 });
    const rejected = page.waitForResponse(response => response.url().endsWith(`/api/chats/${chatIds[0]}/messages`));
    await composer(page).press("Enter");
    expect((await rejected).status()).toBe(409);
    await expect(composer(page)).toHaveValue("Last tab write", { timeout: 30_000 });
    await page.reload();
    await expect(composer(page)).toHaveValue("Last tab write", { timeout: 30_000 });
    await prepareSend(page);
    await composer(page).fill(`Accepted draft ${suffix}`);
    await composer(page).press("Enter");
    await expect(page.locator('article[data-role="assistant"]').last()).toContainText(`Fake answer: Accepted draft ${suffix}`, { timeout: 45_000 });
    await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 45_000 });
    await page.reload();
    await expect(composer(page)).toHaveValue("", { timeout: 30_000 });
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("draft-cleared-after-send-desktop.png") });
  } finally {
    await second?.close();
    for (const id of chatIds) await deleteOwnedChatPermanently(page.request, id).catch(() => undefined);
    if (projectId) await page.request.delete(`/api/projects/${projectId}`).catch(() => undefined);
  }
});

test("temporary input leaves no draft, accounts stay isolated, and sign-out clears only its account", async ({ page, context }, testInfo) => {
  test.setTimeout(120_000);
  await signInWithLocalToken(page);
  // The token helper waits for the shell; wait for workspace bootstrap before
  // changing the blank-chat mode so the route resolver cannot supersede it.
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "New chat mode" }).click();
  await page.getByRole("menu", { name: "New chat mode" }).getByRole("menuitem", { name: /Temporary chat/u }).click();
  await expect(page.getByTestId("header-temporary-indicator")).toBeVisible();
  await composer(page).fill("Temporary input must stay volatile");
  await page.reload();
  await expect(composer(page)).toHaveValue("", { timeout: 30_000 });
  expect(await storedText(page)).toEqual([]);
  await composer(page).fill("First account's unsent text");
  await expect.poll(() => storedText(page)).toContain("First account's unsent text");

  // Expiring cookies without explicit sign-out preserves the first account's
  // entry, so a different login must prove isolation in this same browser.
  await context.clearCookies();
  await page.goto("/login");
  await submitPasswordSignIn(page, LOCAL_RESTRICTED_MEMBER);
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });
  await expect(composer(page)).toHaveValue("");
  await composer(page).fill("Second account's draft");
  await expect.poll(() => storedText(page)).toContain("Second account's draft");
  await runAccountMenuAction(page, "Settings");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Account", exact: true }).click();
  await expect(settings).toContainText("Ends this browser session and removes unsent drafts from this device.");
  for (const [name, width, height] of [["desktop", 1440, 900], ["tablet-portrait", 768, 1024],
    ["tablet-landscape", 1024, 768], ["phone-portrait", 390, 844], ["phone-landscape", 844, 390]] as const) {
    await page.setViewportSize({ width, height });
    await settings.getByRole("button", { name: "Sign out", exact: true }).scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`draft-signout-${name}.png`) });
  }
  await settings.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/u);
  expect(await storedText(page)).toEqual(["First account's unsent text"]);
});

test("sign-out in another tab revokes a login tab's expired-session draft and comments", async ({ page, context }, testInfo) => {
  test.setTimeout(180_000);
  const handoffKey = "aiqsa.sessionExpiredDraft.v1";
  const draft = "This expired-session draft must not return after explicit sign-out";
  const comment = "This pending comment must not return either";
  const source = "Synthetic fragment for expired-session recovery";
  await signInWithLocalToken(page);
  const created = await page.request.post("/api/chats", { data: {
    title: `Expired draft ${randomUUID().slice(0, 8)}`, memoryMode: "EXCLUDED"
  } });
  expect(created.status()).toBe(201);
  const chatId: string = (await created.json()).chat.id;
  let second: Page | undefined;
  try {
    await page.goto(`/c/${chatId}`);
    await sendAndCommentOnMessage(page, source, comment);
    await composer(page).fill(draft);
    await expect.poll(() => storedText(page)).toContain(draft);

    // Invalidate authentication server-side, without the browser's explicit
    // sign-out cleanup. A real 401 then creates the recovery handoff.
    expect((await page.request.post("/api/auth/logout", { data: {} })).ok()).toBe(true);
    await composer(page).press("Enter");
    await expect(page).toHaveURL(/\/login\?next=.*&reason=session_expired$/u, { timeout: 30_000 });
    const handoff = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? "null") as {
      accountId: string; epoch: string; draft: string; comments: { quote: string; text: string }[]; sessionKey: string;
    } | null, handoffKey);
    expect(handoff).toMatchObject({ draft, comments: [{ quote: source, text: comment }], sessionKey: `chat:${chatId}` });
    expect(handoff?.accountId).toBeTruthy();
    expect(handoff?.epoch).toBeTruthy();
    const epochKey = `aiqsa.composerDraftEpoch.v1:${encodeURIComponent(handoff!.accountId)}`;
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).epoch, epochKey)).toBe(handoff!.epoch);

    // The first tab stays on login with its own sessionStorage. The other
    // tab signs into the same account, then explicitly ends that session.
    second = await context.newPage();
    await authenticateWithLocalToken(second.request);
    await second.goto(`/c/${chatId}`);
    await expect(composer(second)).toBeVisible({ timeout: 30_000 });
    expect(await second.evaluate(key => JSON.parse(localStorage.getItem(key)!).epoch, epochKey)).toBe(handoff!.epoch);
    await runAccountMenuAction(second, "Settings");
    const settings = second.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("button", { name: "Account", exact: true }).click();
    await settings.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(second).toHaveURL(/\/login$/u);
    await expect(page).toHaveURL(/\/login\?next=.*&reason=session_expired$/u);
    expect(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? "null"), handoffKey)).toEqual(handoff);
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).epoch, epochKey)).not.toBe(handoff!.epoch);
    expect(await storedText(page)).toEqual([]);

    await authenticateWithLocalToken(page.request);
    await page.goto(`/c/${chatId}`);
    await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), handoffKey)).toBeNull();
    await expect(composer(page)).toHaveValue("", { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "1 comment", exact: true })).toHaveCount(0);
    await page.reload();
    await expect(composer(page)).toHaveValue("", { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "1 comment", exact: true })).toHaveCount(0);
    expect(await storedText(page)).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("expired-draft-revoked-after-sign-out.png") });
  } finally {
    await second?.close();
    // Sign-out may have ended this session; cleanup re-authenticates first.
    if ((await page.request.get(`/api/chats/${chatId}`)).status() === 401) await authenticateWithLocalToken(page.request);
    await deleteOwnedChatPermanently(page.request, chatId);
  }
});

test("a tab signed out from another tab stores nothing until the account signs in again", async ({ page, context }) => {
  test.setTimeout(120_000);
  await signInWithLocalToken(page);
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });
  await composer(page).fill("Typed before sign-out");
  await expect.poll(() => storedText(page)).toContain("Typed before sign-out");
  const second = await context.newPage();
  try {
    await second.goto("/");
    await expect(composer(second)).toHaveValue("Typed before sign-out", { timeout: 30_000 });
    await runAccountMenuAction(second, "Settings");
    const settings = second.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("button", { name: "Account", exact: true }).click();
    await settings.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(second).toHaveURL(/\/login$/u);

    // The first tab drops its text and never writes anything back.
    await expect(composer(page)).toHaveValue("", { timeout: 30_000 });
    await composer(page).fill("Typed while signed out");
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    expect(await storedText(page)).toEqual([]);

    // A sign-in in the other tab resumes the first one; its later text is saved.
    await signInWithLocalToken(second);
    await expect(composer(second)).toBeVisible({ timeout: 30_000 });
    await composer(page).fill("Typed after sign-in");
    await expect.poll(() => storedText(page)).toEqual(["Typed after sign-in"]);
  } finally {
    await second.close();
  }
});

test("sign-out from a freshly loaded Control Center clears the account's draft and comments", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const draft = "This draft must not survive a Control Center sign-out";
  const comment = "This pending comment must not survive it either";
  const source = "Synthetic fragment for Control Center sign-out";
  await signInWithLocalToken(page);
  const created = await page.request.post("/api/chats", { data: {
    title: `Control Center draft ${randomUUID().slice(0, 8)}`, memoryMode: "EXCLUDED"
  } });
  expect(created.status()).toBe(201);
  const chatId: string = (await created.json()).chat.id;
  try {
    await page.goto(`/c/${chatId}`);
    await sendAndCommentOnMessage(page, source, comment);
    await composer(page).fill(draft);
    await expect.poll(() => storedText(page)).toContain(draft);
    const entryKeys = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("aiqsa.composerDrafts.v1:")));
    expect(entryKeys).toHaveLength(1);
    const entryKey = entryKeys[0]!;
    expect(await page.evaluate(key => localStorage.getItem(key), entryKey)).toContain(comment);
    const epochKey = entryKey.replace("aiqsa.composerDrafts.v1:", "aiqsa.composerDraftEpoch.v1:");
    const epoch = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).epoch as string, epochKey);

    // A full document load: Control Center never starts the chat shell's
    // draft observer, so sign-out there must name the account itself.
    await page.goto("/admin");
    await expect(page.getByTestId("admin-section-overview")).toBeVisible({ timeout: 30_000 });
    expect(await storedText(page)).toEqual([draft]);
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menu", { name: "Account", exact: true }).getByRole("menuitem", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/u);
    expect(await page.evaluate(key => localStorage.getItem(key), entryKey)).toBeNull();
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).epoch, epochKey)).not.toBe(epoch);
    expect(await storedText(page)).toEqual([]);

    await signInWithLocalToken(page, `/c/${chatId}`);
    await expect(page.locator('article[data-role="assistant"]').last()).toContainText(`Fake answer: ${source}`, { timeout: 30_000 });
    await expect(composer(page)).toHaveValue("", { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "1 comment", exact: true })).toHaveCount(0);
    expect(await storedText(page)).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("draft-cleared-after-control-center-sign-out.png") });
  } finally {
    // Sign-out may have ended this session; cleanup re-authenticates first.
    if ((await page.request.get(`/api/chats/${chatId}`)).status() === 401) await authenticateWithLocalToken(page.request);
    await deleteOwnedChatPermanently(page.request, chatId);
  }
});
