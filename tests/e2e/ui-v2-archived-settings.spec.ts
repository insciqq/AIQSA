import { expect, test, type Page, type Route } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";

const timestamp = "2026-09-02T14:30:00.000Z";

const archivedSummary = {
  activeLeafMessageId: "archive-assistant",
  archived: true,
  createdAt: timestamp,
  defaultKnowledgePlan: null,
  defaultModelId: "gpt-5.5",
  defaultProvider: "openai",
  folderId: null,
  id: "archive-fixture",
  lastMessageAt: timestamp,
  memoryMode: "NORMAL",
  messageCount: 2,
  pinned: false,
  projectId: null,
  sourceRevision: 7,
  title: "Quarterly evidence review",
  updatedAt: timestamp
} as const;

const archivedDetail = {
  ...archivedSummary,
  lastMessageAt: undefined,
  contextStats: { approximateActiveBranchInputTokens: 12 },
  messages: [{
    artifactSummary: null,
    content: { blocks: [{ text: "Keep the supporting evidence attached.", type: "text" }] },
    createdAt: timestamp,
    errorMessage: null,
    id: "archive-user",
    modelId: null,
    modelRunId: null,
    parentMessageId: null,
    provider: null,
    role: "user",
    status: "complete"
  }, {
    artifactSummary: null,
    content: { blocks: [{ text: "The retained answer stays available in preview.", type: "text" }] },
    createdAt: timestamp,
    errorMessage: null,
    id: "archive-assistant",
    modelId: "gpt-5.5",
    modelRunId: "run-archive",
    parentMessageId: "archive-user",
    provider: "openai",
    role: "assistant",
    status: "complete"
  }],
  pageInfo: {
    activeLeafMessageId: "archive-assistant",
    beforeCursor: null,
    hasOlder: false,
    snapshotUpdatedAt: timestamp
  },
  usageStats: null
};

async function installArchiveRoutes(page: Page) {
  let deleted = false;
  let restored = false;
  let restoreRequests = 0;
  await page.route("**/api/chats/archived", async (route: Route) => {
    await route.fulfill({
      contentType: "application/json",
      json: { chats: restored || deleted ? [] : [archivedSummary], nextCursor: null }
    });
  });
  await page.route("**/api/chats/archive-fixture/archive", async (route: Route) => {
    await route.fulfill({ contentType: "application/json", json: { chat: archivedDetail } });
  });
  await page.route("**/api/chats/archive-fixture/restore", async (route: Route) => {
    expect(route.request().postDataJSON()).toEqual({ expectedChatRevision: 7 });
    restoreRequests += 1;
    restored = true;
    await route.fulfill({
      contentType: "application/json",
      json: {
        chat: {
          archived: false,
          id: archivedSummary.id,
          memoryMode: archivedSummary.memoryMode,
          sourceRevision: 8,
          updatedAt: timestamp
        }
      }
    });
  });
  await page.route("**/api/chats/archive-fixture/delete-permanently", async (route: Route) => {
    deleted = true;
    await route.fulfill({ contentType: "application/json", json: { status: "IN_PROGRESS" } });
  });
  await page.route("**/api/chats/archive-fixture/delete-permanently/status", async (route: Route) => {
    await route.fulfill({ contentType: "application/json", json: { status: "IN_PROGRESS" } });
  });
  return { restoreRequests: () => restoreRequests };
}

test("Archived chats is a focus-safe Data task with list, preview, and restore", async ({ context, page }) => {
  const requests = await installArchiveRoutes(page);
  await context.addCookies([{
    domain: "127.0.0.1",
    name: "aiqsa.theme",
    path: "/",
    value: "dark"
  }]);
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto("/ui-v2-fixture?fixture=settings&state=archived");

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Manage" }).click();
  await expect(settings.getByRole("heading", { name: "Data / Archived chats" })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Back to Data" })).toBeFocused();
  const archive = settings.getByTestId("settings-archived-panel");
  await expect(archive.getByText(/Last message Sep 2, 2026 · 2 messages/u)).toBeVisible();
  await expect(archive.getByRole("button", { name: "Restore Quarterly evidence review" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Archived chats" })).toHaveCount(0);

  await archive.getByRole("button", { name: "Open preview: Quarterly evidence review" }).click();
  await expect(archive.getByRole("heading", { name: "Quarterly evidence review" })).toBeVisible();
  await expect(archive.getByRole("button", { name: "Archived chats" })).toBeFocused();
  await expect(archive.getByText("The retained answer stays available in preview.")).toBeVisible();
  await expect(archive.getByRole("textbox")).toHaveCount(0);
  await archive.getByRole("button", { name: "Archived chats" }).click();
  await expect(archive.getByRole("button", { name: "Open preview: Quarterly evidence review" })).toBeFocused();
  await archive.getByRole("button", { name: "Open preview: Quarterly evidence review" }).click();
  await archive.getByRole("button", { name: "Restore Quarterly evidence review" }).click();
  await expect.poll(requests.restoreRequests).toBe(1);
  await expect(archive.getByRole("heading", { name: "No archived chats" })).toBeVisible();
  await expect(archive.getByRole("searchbox", { name: "Search archived chats" })).toBeFocused();

  await settings.getByRole("button", { name: "Back to Data" }).click();
  await expect(settings.getByRole("button", { name: "Manage" })).toBeFocused();
});

test("Archived chat controls stay reachable on mobile and nest permanent deletion above Settings", async ({ page }) => {
  await installArchiveRoutes(page);
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/ui-v2-fixture?fixture=settings&state=archived");

  const settings = page.getByTestId("settings-v2");
  await settings.getByRole("button", { name: "Manage" }).click();
  const archive = settings.getByTestId("settings-archived-panel");
  await expect(archive.getByRole("button", { name: "Open preview: Quarterly evidence review" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  for (const control of [
    settings.getByRole("button", { name: "Back to Data" }),
    archive.getByRole("button", { name: "Restore Quarterly evidence review" }),
    archive.getByRole("button", { name: "Actions: Quarterly evidence review" })
  ]) {
    const box = await control.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box?.width).toBeGreaterThanOrEqual(44);
  }

  await archive.getByRole("button", { name: "Actions: Quarterly evidence review" }).click();
  await page.getByRole("menuitem", { name: "Delete permanently…" }).click();
  const confirmation = page.getByRole("dialog", { name: "Delete this chat permanently?" });
  await expect(confirmation).toBeVisible();
  await expect(settings).toHaveAttribute("aria-hidden", "true");
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(settings).not.toHaveAttribute("aria-hidden", "true");
  await expect(archive.getByRole("button", { name: "Actions: Quarterly evidence review" })).toBeFocused();

  await archive.getByRole("button", { name: "Actions: Quarterly evidence review" }).click();
  await page.getByRole("menuitem", { name: "Delete permanently…" }).click();
  await page.getByRole("dialog", { name: "Delete this chat permanently?" })
    .getByRole("button", { name: "Delete permanently" }).click();
  const status = page.getByRole("dialog", { name: "Permanent deletion" });
  await expect(status).toBeVisible();
  await status.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(status).toHaveCount(0);
  await expect(archive.getByRole("heading", { name: "No archived chats" })).toBeVisible();
  await expect(archive.getByRole("searchbox", { name: "Search archived chats" })).toBeFocused();
});
