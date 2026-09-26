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

/** Signs in and opens `destination`, a chat address such as `/c/<id>` or the new chat. */
export async function signInWithLocalToken(page: Page, destination = "/"): Promise<void> {
  await page.goto(destination);
  await expect(page).toHaveURL(/\/login/);
  await authenticateWithLocalToken(page.request);
  await page.goto(destination);
  await expect(page.getByTestId("app-shell")).toBeVisible();
}
