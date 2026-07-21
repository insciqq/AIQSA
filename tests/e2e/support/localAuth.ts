import { expect, type APIRequestContext, type Page } from "@playwright/test";

const localAuthToken = "aiqsa-test-token";

export async function authenticateWithLocalToken(
  request: APIRequestContext,
  failureMessage?: string
): Promise<void> {
  const response = await request.post("/api/auth/token", {
    data: { token: localAuthToken }
  });

  if (failureMessage) {
    expect(response.ok(), failureMessage).toBe(true);
    return;
  }

  expect(response.ok()).toBe(true);
}

export async function signInWithLocalToken(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await authenticateWithLocalToken(page.request);
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();
}
