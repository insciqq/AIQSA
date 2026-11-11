/**
 * A page translator (Chrome, Yandex) swaps the text nodes React rendered for
 * its own `<font>` elements. Buttons that put a spinner or icon beside bare
 * text then crashed the page (prod audit 2026-11-11): the sign-in button on a
 * wrong password, and Delete permanently, whose crash also aborted the delete
 * it had just sent. Each case here translates the page the way Chrome does
 * just before the click, then checks that no error screen or page error
 * follows, the control shows its busy state, and the delete request settles.
 *
 * Needs only the fake-provider stand: password sign-in on (the default) and
 * the permanent chat deletion capability, as `permanent-delete-navigation`
 * does. Viewport screenshots at desktop and phone go to the test output.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { signInWithLocalToken } from "./support/localAuth";

const SIZES = [
  { height: 900, name: "desktop", width: 1440 },
  { height: 844, name: "phone", width: 390 }
] as const;

/** What Chrome's translator does to a page: every visible text node becomes `<font><font>text</font></font>`. */
async function translatePage(page: Page): Promise<number> {
  return page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => node.parentElement?.closest("script, style, noscript") || !(node.nodeValue ?? "").trim()
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT
    });
    const texts: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
    for (const text of texts) {
      const outer = document.createElement("font");
      const inner = document.createElement("font");
      inner.textContent = text.nodeValue;
      outer.append(inner);
      text.replaceWith(outer);
    }
    document.documentElement.classList.add("translated-ltr");
    return texts.length;
  });
}

/** Collects uncaught page errors; the caller asserts none happened. */
function watchPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.name));
  return errors;
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

for (const size of SIZES) {
  test(`a wrong password on a translated login page shows the refusal, not an error screen (${size.name})`, async ({ browser }, testInfo) => {
    test.setTimeout(90_000);
    const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, viewport: { height: size.height, width: size.width } });
    try {
      const page = await context.newPage();
      const errors = watchPageErrors(page);
      await page.goto("/login");
      const form = page.locator('form[data-hydrated="true"]');
      await expect(form).toBeVisible({ timeout: 60_000 });
      await form.getByLabel("Email").fill(`translated-${randomUUID()}@example.invalid`);
      await form.getByLabel("Password", { exact: true }).fill(`Wrong-${randomUUID()}`);
      expect(await translatePage(page)).toBeGreaterThan(0);
      const login = page.waitForResponse((item) => item.request().method() === "POST" && new URL(item.url()).pathname === "/api/auth/login");
      await form.locator("button[type=submit]").click();
      expect((await login).status()).toBe(401);
      await expect(page.locator("#login-feedback[role=alert]")).toBeVisible({ timeout: 30_000 });
      await expect(form.locator("button[type=submit]")).toBeEnabled();
      await expect(page.getByTestId("app-error-screen")).toHaveCount(0);
      expect(errors).toEqual([]);
      await shot(page, testInfo, `login-refused-translated-${size.name}`);
    } finally {
      await context.close();
    }
  });

  for (const from of ["open chat", "home"] as const) {
    test(`Delete permanently on a translated page settles the delete without an error screen (${from}, ${size.name})`, async ({ page }, testInfo) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ height: size.height, width: size.width });
      await signInWithLocalToken(page);
      const errors = watchPageErrors(page);
      const owned: string[] = [];
      try {
        const title = `Translated deletion ${randomUUID().slice(0, 8)}`;
        for (const name of [`${title} survivor`, title]) {
          const response = await page.request.post("/api/chats", { data: { memoryMode: "EXCLUDED", title: name } });
          expect(response.status()).toBe(201);
          owned.push((await response.json()).chat.id);
        }
        const target = owned[1]!;
        await page.goto(from === "home" ? "/" : `/c/${target}`);
        await expect(page.getByTestId("app-shell")).toBeVisible();
        const drawer = page.getByRole("complementary", { name: "Chat navigation", exact: true });
        const row = page.locator(`[data-navigation-chat-id="${target}"]`);
        // The phone keeps the chat list in a drawer; on desktop it is open, and the row may still be loading.
        if (size.name === "phone") await page.getByRole("button", { name: "Open sidebar" }).click();
        await expect(row).toBeVisible();
        await row.getByRole("button", { name: `Actions: ${title}` }).click();
        await page.getByRole("menuitem", { name: "Delete…", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Delete this chat permanently?" });
        await expect(dialog).toBeVisible();
        expect(await translatePage(page)).toBeGreaterThan(0);

        const failed: string[] = [];
        page.on("requestfailed", (request) => {
          if (new URL(request.url()).pathname.endsWith("/delete-permanently")) failed.push(request.failure()?.errorText ?? "failed");
        });
        const response = page.waitForResponse((item) => item.request().method() === "POST" &&
          new URL(item.url()).pathname === `/api/chats/${target}/delete-permanently`);
        await dialog.getByRole("button", { name: "Delete permanently", exact: true }).click();
        expect((await response).status()).toBe(202);
        const status = page.getByRole("dialog", { name: "Permanent deletion", exact: true });
        await expect(status).toBeVisible();
        await shot(page, testInfo, `delete-status-translated-${from.replace(" ", "-")}-${size.name}`);
        await expect(page.getByTestId("app-error-screen")).toHaveCount(0);
        expect(errors).toEqual([]);
        expect(failed).toEqual([]);
        await status.getByRole("button", { name: "Close", exact: true }).last().click();
        await expect(row).toHaveCount(0);
        await expect.poll(async () => (await page.request.get(`/api/chats/${target}`)).status()).toBe(404);
        expect(errors).toEqual([]);
        if (await drawer.isVisible()) await shot(page, testInfo, `delete-done-translated-${from.replace(" ", "-")}-${size.name}`);
      } finally {
        for (const id of owned) await page.request.delete(`/api/chats/${id}`);
      }
    });
  }
}
