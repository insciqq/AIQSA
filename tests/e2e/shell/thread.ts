import { expect, type Page } from "@playwright/test";

export function sseEvent(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function expectThreadTextInViewport(page: Page, text: string): Promise<void> {
  const locator = page.getByTestId("thread").locator("p").filter({ hasText: text }).last();

  await expect(locator).toBeVisible();
  await expect
    .poll(async () =>
      locator.evaluate((element) => {
        const thread = document.querySelector('[data-testid="thread"]');
        if (!thread) {
          return false;
        }

        const rect = element.getBoundingClientRect();
        const threadRect = thread.getBoundingClientRect();

        return rect.top >= threadRect.top && rect.bottom <= threadRect.bottom;
      })
    )
    .toBe(true);
}

export function assistantContentWithText(page: Page, text: string) {
  return page
    .getByTestId("thread")
    .getByTestId("assistant-message-content")
    .filter({ hasText: text })
    .last();
}

export async function threadTextIsInViewport(page: Page, text: string): Promise<boolean> {
  const locator = page.getByTestId("thread").locator("p").filter({ hasText: text }).last();

  await expect(locator).toBeVisible();

  return locator.evaluate((element) => {
    const thread = document.querySelector('[data-testid="thread"]');
    if (!thread) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const threadRect = thread.getBoundingClientRect();

    return rect.top >= threadRect.top && rect.bottom <= threadRect.bottom;
  });
}

export function scrollMessage(
  id: string,
  role: "assistant" | "user",
  text: string,
  parentMessageId: string | null
) {
  return {
    artifactSummary: null,
    content: {
      blocks: [{ text, type: "text" }]
    },
    createdAt: "2026-06-10T00:00:00.000Z",
    errorMessage: null,
    id,
    modelId: "gpt-5.5",
    modelRunId: role === "assistant" ? `run-${id}` : null,
    parentMessageId,
    provider: "openai",
    role,
    status: "complete"
  };
}
