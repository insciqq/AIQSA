import { expect, test, type Locator, type Page } from "@playwright/test";

// The disposable app must have synthetic AIQSA_YANDEX_OAUTH_CLIENT_ID and
// AIQSA_YANDEX_OAUTH_CLIENT_SECRET configured. Fetch the real start response
// without following its redirect; these checks never visit a consent session.
const safeNext = "/admin?tab=users#section";
const outcomes = [
  { outcome: undefined, message: undefined },
  { outcome: "not_allowed", message: "This Yandex account is not allowed to access AIQSA." },
  { outcome: "pending", message: "Yandex confirmed your account. AIQSA access is pending administrator approval." },
  { outcome: "account_conflict", message: "Yandex could not be linked to this AIQSA account." },
  { outcome: "cancelled", message: "Yandex sign-in was cancelled." },
  { outcome: "failed", message: "Yandex sign-in could not be completed." }
] as const;
const profiles = [
  { name: "desktop light keyboard", theme: "light", touch: false, viewport: { width: 1280, height: 900 } },
  { name: "narrow dark touch", theme: "dark", touch: true, viewport: { width: 390, height: 844 } }
] as const;

async function expectReachableControl(page: Page, control: Locator) {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeInViewport({ ratio: 1 });
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(await page.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth &&
    document.body.scrollWidth <= window.innerWidth
  )).toBe(true);
}

async function tabToControl(page: Page, control: Locator) {
  await page.getByLabel("Email", { exact: true }).focus();
  for (let index = 0; index < 10; index += 1) {
    await page.keyboard.press("Tab");
    if (await control.evaluate((element) => element === document.activeElement)) break;
  }
  await expect(control).toBeFocused();
  expect(await control.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  await expect(control).not.toHaveCSS("box-shadow", "none");
}

for (const profile of profiles) {
  test.describe(profile.name, () => {
    test.use({ colorScheme: profile.theme, hasTouch: profile.touch, viewport: profile.viewport });

    test("offers Yandex recovery for every callback outcome and starts a fresh account selection", async ({ baseURL, context, page }, testInfo) => {
      test.setTimeout(60_000);
      const appOrigin = new URL(baseURL!).origin;
      const interceptedStarts: { location: string; status: number }[] = [];
      const unexpectedExternalOrigins: string[] = [];
      const pageErrors: string[] = [];
      const hydrationErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error" && /hydration|hydrated|server rendered html/i.test(message.text())) {
          hydrationErrors.push(message.text());
        }
      });
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== appOrigin) {
          unexpectedExternalOrigins.push(url.origin);
          await route.abort();
          return;
        }
        if (url.pathname !== "/api/auth/oauth/yandex") {
          await route.continue();
          return;
        }
        const response = await route.fetch({ maxRedirects: 0, timeout: 10_000 });
        const headers = response.headers();
        interceptedStarts.push({ location: headers.location ?? "", status: response.status() });
        // Preserve the real temporary cookie while replacing the external
        // redirect with a local acknowledgement of native link activation.
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          headers: headers["set-cookie"] ? { "set-cookie": headers["set-cookie"] } : {},
          body: '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><h1>Authorization intercepted</h1></body></html>'
        });
      });
      await context.addCookies([{ name: "aiqsa.theme", value: profile.theme, url: appOrigin }]);
      let previousState: string | null = null;
      let previousChallenge: string | null = null;
      let previousFlowCookie: string | null = null;

      for (const state of outcomes) {
        const nextPath = state.outcome === "failed" ? "https://evil.example/steal" : safeNext;
        const expectedNext = state.outcome === "failed" ? "/" : safeNext;
        const query = new URLSearchParams({ next: nextPath });
        if (state.outcome) {
          query.set("oauth", state.outcome);
          query.set("provider", "yandex");
        }
        await page.goto(`/login?${query}`);
        await expect(page.locator("html")).toHaveAttribute("data-theme", profile.theme);
        const ordinary = page.getByRole("link", { name: "Continue with Yandex" });
        await expect(ordinary, "Configure synthetic Yandex OAuth credentials on the disposable stand").toBeVisible();
        await expect(ordinary).toHaveAttribute("href", `/api/auth/oauth/yandex?${new URLSearchParams({ next: expectedNext })}`);
        const recovery = page.getByRole("link", { name: "Use another Yandex account" });
        let action = ordinary;
        if (state.outcome) {
          await expect(page.getByTestId("auth-root").getByRole(state.outcome === "pending" ? "status" : "alert")).toContainText(state.message);
          await expect(recovery).toBeVisible();
          await expect(recovery).toHaveAccessibleDescription("Choose another Yandex account to try signing in again.");
          await expect(recovery).toHaveAttribute("href", `/api/auth/oauth/yandex?${new URLSearchParams({
            next: expectedNext, switch_account: "1"
          })}`);
          action = recovery;
        } else {
          await expect(recovery).toHaveCount(0);
          await expect(page.getByTestId("auth-root").getByRole("alert")).toHaveCount(0);
        }
        await expectReachableControl(page, action);
        if (!profile.touch) await tabToControl(page, action);
        if (state.outcome === "not_allowed") {
          await testInfo.attach(`yandex-recovery-${profile.theme}`, {
            body: await page.screenshot({ fullPage: true }), contentType: "image/png"
          });
        }
        const countBefore = interceptedStarts.length;
        await Promise.all([
          page.waitForResponse((response) => new URL(response.url()).pathname === "/api/auth/oauth/yandex"),
          profile.touch ? action.tap() : page.keyboard.press("Enter")
        ]);
        await expect(page.getByRole("heading", { name: "Authorization intercepted" })).toBeVisible();
        expect(interceptedStarts).toHaveLength(countBefore + 1);
        const start = interceptedStarts.at(-1)!;
        expect(start.status).toBe(303);
        const authorization = new URL(start.location);
        expect(authorization.origin).toBe("https://oauth.yandex.ru");
        expect(authorization.pathname).toBe("/authorize");
        expect(authorization.searchParams.get("force_confirm")).toBe(state.outcome ? "yes" : null);
        expect(authorization.searchParams.get("redirect_uri")).toBe(`${appOrigin}/api/auth/oauth/yandex/callback`);
        expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
        expect(authorization.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(authorization.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(authorization.searchParams.get("state")).not.toBe(previousState);
        expect(authorization.searchParams.get("code_challenge")).not.toBe(previousChallenge);
        expect(authorization.searchParams.has("switch_account")).toBe(false);
        expect(authorization.searchParams.has("next")).toBe(false);
        const cookies = await context.cookies(`${appOrigin}/api/auth/oauth/yandex`);
        const flowCookie = cookies.find((cookie) => cookie.name === "aiqsa_oauth_flow");
        expect(flowCookie).toMatchObject({ httpOnly: true, path: "/api/auth/oauth", sameSite: "Lax" });
        expect(flowCookie!.value).not.toBe(previousFlowCookie);
        expect(cookies.some((cookie) => cookie.name === "aiqsa_session")).toBe(false);
        previousState = authorization.searchParams.get("state");
        previousChallenge = authorization.searchParams.get("code_challenge");
        previousFlowCookie = flowCookie!.value;
      }
      expect(pageErrors).toEqual([]);
      expect(hydrationErrors).toEqual([]);
      expect(unexpectedExternalOrigins).toEqual([]);
    });
  });
}
