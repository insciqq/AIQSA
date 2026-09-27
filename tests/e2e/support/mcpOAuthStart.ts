import { expect, type Page } from "@playwright/test";

/**
 * Starts MCP OAuth the way the UI does: a same-origin fetch POST from an app
 * page, then a document navigation to the location it answers. Start routes
 * have no GET; the page must already be on the application origin.
 */
export async function startMcpOAuth(page: Page, action: string): Promise<string> {
  if (!/^https?:/u.test(page.url())) await page.goto("/login");
  const answer = await page.evaluate(async (url) => {
    const response = await fetch(url, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      method: "POST"
    });
    const body = await response.json().catch(() => null) as { location?: unknown } | null;
    return { location: typeof body?.location === "string" ? body.location : null, status: response.status };
  }, action);
  expect(answer.status).toBe(200);
  expect(answer.location).toBeTruthy();
  await page.goto(answer.location!);
  return answer.location!;
}
