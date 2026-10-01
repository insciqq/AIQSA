import { expect, test, type Page, type Route } from "@playwright/test";
import {
  memoryConsumerItemFixture,
  memoryConsumerListFixture,
  memoryConsumerSettingsFixture
} from "../support/memoryFixtures";
import type { MemoryActionFeedback, MemoryAnswerSource } from "../../lib/contracts/memoryClient";
import type { MemoryCommandFeedback } from "../../lib/contracts/memoryCommand";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { runAccountMenuAction } from "./shell/page";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

// Users never see Memory failures, limits, unavailability or load errors; the
// states stay in the data, for models and for administrators.
const timestamp = "2026-10-01T10:00:00.000Z";
const failureCopy = /could not be (?:confirmed|completed|loaded|opened)|no longer applies|was not changed|not applied|temporarily unavailable|was unavailable|with limitations|too long for Memory|Source unavailable|source is unavailable|Memory search unavailable|limited results|memory_[a-z_]+/iu;

type FixtureMessage = Readonly<{
  action?: MemoryActionFeedback;
  errorMessage?: string;
  id: string;
  memorySources?: readonly MemoryAnswerSource[];
  memoryStatus?: "INPUT_TOO_LONG" | "LIMITED" | "UNAVAILABLE";
  parentMessageId: string | null;
  role: "assistant" | "user";
  status?: "complete" | "error";
  text: string;
}>;

function message(input: FixtureMessage) {
  return {
    artifactSummary: input.role === "assistant" ? {
      citations: [],
      ...(input.action ? { memoryAction: input.action } : {}),
      ...(input.memorySources ? { memorySources: [...input.memorySources] } : {}),
      ...(input.memoryStatus ? { memoryStatus: input.memoryStatus } : {}),
      reasoningText: [],
      sources: []
    } : null,
    content: { blocks: input.text ? [{ text: input.text, type: "text" }] : [] },
    createdAt: timestamp,
    errorMessage: input.errorMessage ?? null,
    id: input.id,
    modelId: input.role === "assistant" ? "gpt-5.5" : null,
    modelRunId: input.role === "assistant" ? `run-${input.id}` : null,
    parentMessageId: input.parentMessageId,
    provider: input.role === "assistant" ? "openai" : null,
    role: input.role,
    status: input.status ?? "complete"
  };
}

function conversation(id: string, title: string, turns: readonly Omit<FixtureMessage, "parentMessageId">[]) {
  const messages = turns.map((turn, index) => message({
    ...turn, parentMessageId: index === 0 ? null : turns[index - 1]!.id
  }));
  return {
    activeLeafMessageId: messages.at(-1)!.id,
    createdAt: timestamp,
    defaultModelId: "gpt-5.5",
    defaultProvider: "openai",
    folderId: null,
    id,
    messageCount: messages.length,
    messages,
    pinned: false,
    title,
    updatedAt: timestamp,
    usageStats: null
  };
}

function command(operation: MemoryCommandFeedback["operation"], status: MemoryCommandFeedback["status"]): MemoryCommandFeedback {
  return { commandRef: `opaque-command-${operation}-${status}`.toLowerCase(), operation, status, updatedAt: timestamp };
}

async function routeMemorySettings(page: Page, status: "ON" | "UNAVAILABLE" = "ON") {
  await page.route("**/api/me/memory/settings", (route: Route) => route.request().method() === "GET"
    ? route.fulfill({ json: memoryConsumerSettingsFixture({
      settings: { learnAutomatically: true, referenceChatHistory: true, useMemoryFacts: true }, status
    }) })
    : route.fallback());
}

// Next.js keeps its route announcer as a permanent role=alert region.
const appAlerts = (page: Page) => page.locator("[role='alert']:not(#__next-route-announcer__)");

async function expectNoMemoryFailure(page: Page) {
  await expect(page.locator("body")).not.toContainText(failureCopy);
  await expect(appAlerts(page)).toHaveCount(0);
}

test("reopening a chat with historical Memory command outcomes shows no failure notice", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  const chat = conversation("chat-memory-history", "Memory history", [
    { id: "user-failed", role: "user", text: "Remember that I cycle to work." },
    { id: "assistant-failed", role: "assistant", text: "Noted the commute." },
    { id: "user-unknown", role: "user", text: "What should I cook tonight?" },
    { id: "assistant-unknown", role: "assistant", text: "Try a quick risotto." },
    { id: "user-stale", role: "user", text: "Change my city to Porto." },
    { id: "assistant-stale", role: "assistant", text: "Porto it is." },
    { id: "user-rejected", role: "user", text: "Forget my old phone model." },
    { id: "assistant-rejected", role: "assistant", text: "Understood." },
    { id: "user-saved", role: "user", text: "Remember that I prefer tea." },
    { id: "assistant-saved", role: "assistant", text: "Tea noted." }
  ]);
  await installMatrixCatalogFixture(page, { chats: [chat], folders: [] });
  await routeMemorySettings(page);
  let commandReads = 0;
  await page.route("**/api/me/chats/*/memory-commands", async (route: Route) => {
    commandReads += 1;
    await route.fulfill({ json: { commands: [
      { feedback: command("SAVE", "FAILED"), messageId: "user-failed" },
      // An ordinary message whose classifier could not decide stays quiet.
      { feedback: command("UNKNOWN", "UNKNOWN"), messageId: "user-unknown" },
      { feedback: command("UPDATE", "STALE"), messageId: "user-stale" },
      { feedback: command("FORGET", "REJECTED"), messageId: "user-rejected" },
      { feedback: command("SAVE", "COMMITTED"), messageId: "user-saved" }
    ] } });
  });
  await signInWithLocalToken(page, `/c/${chat.id}`);

  await expect(page.getByText("Tea noted.")).toBeVisible();
  await expect.poll(() => commandReads).toBeGreaterThan(0);
  const notices = page.getByTestId("memory-command-status");
  await expect(notices).toHaveCount(1);
  await expect(page.locator('[data-message-id="assistant-saved"]').getByTestId("memory-command-status"))
    .toContainText("Memory saved.");
  for (const id of ["assistant-failed", "assistant-unknown", "assistant-stale", "assistant-rejected"]) {
    await expect(page.locator(`[data-message-id="${id}"]`).getByTestId("memory-command-status")).toHaveCount(0);
  }
  await expectNoMemoryFailure(page);
  await page.reload();
  await expect(page.getByText("Tea noted.")).toBeVisible();
  await expect(notices).toHaveCount(1);
  await expectNoMemoryFailure(page);
  await expectNoHorizontalOverflow(page);
});

test("Memory run failures, limits and unavailable sources read neutrally in chat", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  const available: MemoryAnswerSource = {
    actions: ["CORRECT", "FORGET", "NOT_RELEVANT"],
    date: timestamp,
    memoryRef: "opaque-available-source",
    sourceAvailable: true,
    sourceType: "SAVED_MEMORY",
    text: "I prefer tea in the afternoon."
  };
  const chat = conversation("chat-memory-neutral", "Neutral Memory", [
    { id: "user-limited", role: "user", text: "What do I drink?" },
    { id: "assistant-limited", memorySources: [available, {
      actions: [], date: timestamp, sourceAvailable: false, sourceType: "SAVED_MEMORY"
    }], memoryStatus: "LIMITED", role: "assistant", text: "You prefer tea." },
    { id: "user-unavailable", role: "user", text: "And for breakfast?" },
    { id: "assistant-unavailable", memoryStatus: "UNAVAILABLE", role: "assistant", text: "Something light." },
    { id: "user-search", role: "user", text: "Check my notes." },
    { errorMessage: "Memory search could not be settled.", id: "assistant-search", role: "assistant",
      status: "error", text: "" },
    { id: "user-forgotten", role: "user", text: "Continue." },
    // Historical text persisted before the neutral server copy.
    { errorMessage: "Memory preparation stopped because a selected Memory item was forgotten.",
      id: "assistant-forgotten", role: "assistant", status: "error", text: "" }
  ]);
  await installMatrixCatalogFixture(page, { chats: [chat], folders: [] });
  await routeMemorySettings(page);
  await signInWithLocalToken(page, `/c/${chat.id}`);

  const limited = page.locator('[data-message-id="assistant-limited"]');
  await expect(limited.getByText("You prefer tea.")).toBeVisible();
  const process = limited.getByTestId("tool-activity-disclosure");
  await expect(process.locator(":scope > summary")).toContainText("Memory · 1");
  await process.locator(":scope > summary").click();
  await limited.getByTestId("memories-disclosure").locator(":scope > summary").click();
  await expect(limited.getByTestId("memory-source-card")).toHaveCount(1);
  await expect(limited.getByTestId("answer-outputs")).toHaveCount(0);
  const unavailable = page.locator('[data-message-id="assistant-unavailable"]');
  await expect(unavailable.getByText("Something light.")).toBeVisible();
  await expect(unavailable.locator("[data-testid$='-status'], .v2-memory-answer-state")).toHaveCount(0);

  const failed = page.locator('[data-message-id="assistant-forgotten"]');
  const card = failed.getByRole("region", { name: "Run failed" });
  await expect(card).toContainText("Request not completed");
  await expect(card).toContainText("The answer could not be prepared. Try again.");
  await expect(card).not.toContainText(/memory/iu);
  await expect(card.getByRole("button", { name: "Regenerate" })).toBeVisible();
  await expect(page.locator('[data-message-id="assistant-search"]')).toContainText("The answer could not be prepared. Try again.");
  await expect(page.locator("body")).not.toContainText(failureCopy);
  await expectNoHorizontalOverflow(page);
});

test("failed chat Memory actions restore their controls without any message", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  const chat = conversation("chat-memory-actions-fail", "Memory actions fail", [
    { id: "user-save", role: "user", text: "Remember that I prefer tea." },
    { action: { memoryRef: "opaque-saved-ref", operation: "SAVE", statement: "I prefer tea.", status: "COMMITTED" },
      id: "assistant-save", memorySources: [{
        actions: ["CORRECT", "FORGET", "NOT_RELEVANT", "OPEN_SOURCE"], date: timestamp,
        memoryRef: "opaque-source-ref", sourceAvailable: true, sourceType: "LEARNED_MEMORY", text: "I live in Lisbon."
      }], role: "assistant", text: "Saved." }
  ]);
  await installMatrixCatalogFixture(page, { chats: [chat], folders: [] });
  await routeMemorySettings(page);
  const actions: string[] = [];
  await page.route("**/api/me/memory/source-actions", async (route: Route) => {
    actions.push(String((route.request().postDataJSON() as { action?: unknown }).action));
    await route.fulfill({ status: 500, json: { error: "memory_action_failed" } });
  });
  let modePatches = 0;
  await page.route("**/api/me/chats/*/memory-mode", async (route: Route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { allowedActions: ["EXCLUDE"], archived: false, mode: "NORMAL",
        temporaryRetentionDeadline: null } });
      return;
    }
    modePatches += 1;
    await route.fulfill({ status: 500, json: { error: "memory_action_failed" } });
  });
  await signInWithLocalToken(page, `/c/${chat.id}`);

  const answer = page.locator('[data-message-id="assistant-save"]');
  await expect(answer.getByText("Memory saved.", { exact: true })).toBeVisible();
  await answer.getByTestId("memory-action-menu").click();
  await answer.getByRole("menuitem", { name: "Forget" }).click();
  await expect.poll(() => actions.length).toBe(1);
  await expect(answer.getByTestId("memory-action-menu")).toBeEnabled();
  await answer.getByTestId("memory-action-menu").click();
  await expect(answer.getByRole("menuitem", { name: "Edit" })).toBeVisible();
  await expect(answer.getByRole("menuitem", { name: "Forget" })).toBeVisible();
  await page.keyboard.press("Escape");

  await answer.getByTestId("tool-activity-disclosure").locator(":scope > summary").click();
  await answer.getByTestId("memories-disclosure").locator(":scope > summary").click();
  const row = answer.getByTestId("memory-source-card");
  await row.getByTestId("memory-source-actions").click();
  await page.getByRole("menuitem", { name: "Forget" }).click();
  await expect.poll(() => actions.length).toBe(2);
  await expect(row).toContainText("I live in Lisbon.");
  await expect(row.getByTestId("memory-source-actions")).toBeEnabled();
  await row.getByRole("button", { name: "Open source" }).click();
  await expect.poll(() => actions.length).toBe(3);
  await expect(row.getByRole("button", { name: "Open source" })).toBeEnabled();
  await expect(row.getByRole("link", { name: "Open source" })).toHaveCount(0);
  expect(actions).toEqual(["FORGET", "FORGET", "OPEN_SOURCE"]);

  const headerMenuTrigger = page.getByTestId("header-more-trigger");
  await headerMenuTrigger.click();
  await page.getByTestId("header-more-menu").getByRole("menuitem", { name: "Exclude from Memory" }).click();
  await expect.poll(() => modePatches).toBe(1);
  await headerMenuTrigger.click();
  await expect(page.getByTestId("header-more-menu").getByRole("menuitem", { name: "Exclude from Memory" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("shell-notice")).toHaveCount(0);
  await expectNoMemoryFailure(page);
});

test("a Memory admission refusal on send shows neutral copy without a raw code", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  const chat = conversation("chat-memory-refusal", "Memory refusal", [
    { id: "user-first", role: "user", text: "Hello." },
    { id: "assistant-first", role: "assistant", text: "Hi there." }
  ]);
  await installMatrixCatalogFixture(page, { chats: [chat], folders: [] });
  await routeMemorySettings(page);
  await page.route("**/api/chats/*/messages", (route: Route) => route.request().method() === "POST"
    ? route.fulfill({ status: 409, json: { error: "memory_attempt_item_stale" } })
    : route.fallback());
  await signInWithLocalToken(page, `/c/${chat.id}`);

  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("Plan my week.");
  await composer.press("Enter");
  await expect(page.getByText("The answer could not be prepared. Try again.").first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/memory_attempt_item_stale|memory attempt item stale/iu);
  await expect(composer).toHaveValue("Plan my week.");
});

test("Studio Memory keeps last known data and usable controls after failed reads and writes", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ height: 900, width: 1440 });
  const item = memoryConsumerItemFixture({ memoryRef: "opaque-studio-ref", statement: "I prefer tea." });
  await installMatrixCatalogFixture(page, { chats: [], folders: [] });
  await routeMemorySettings(page, "UNAVAILABLE");
  let listReads = 0;
  let failReads = true;
  await page.route("**/api/me/memories?*", async (route: Route) => {
    listReads += 1;
    if (failReads) await route.fulfill({ status: 503, json: { error: "memory_unavailable" } });
    else await route.fulfill({ json: memoryConsumerListFixture([item]) });
  });
  const writes: string[] = [];
  await page.route("**/api/me/memories/*/forget", async (route: Route) => {
    writes.push("forget");
    await route.fulfill({ status: 500, json: { error: "memory_action_failed" } });
  });
  let patches = 0;
  await page.route("**/api/me/memory/settings", async (route: Route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    patches += 1;
    await route.fulfill({ status: 500, json: { error: "memory_action_failed" } });
  });
  await signInWithLocalToken(page, "/");
  await runAccountMenuAction(page, "Memory");
  const library = page.getByTestId("library-v2");

  // Three bounded background retries, then a calm Reload instead of an error.
  const reload = library.getByTestId("memory-list-reload");
  await expect(reload).toBeVisible({ timeout: 20_000 });
  expect(listReads).toBeGreaterThanOrEqual(4);
  const settledReads = listReads;
  await page.waitForTimeout(5_000);
  expect(listReads).toBe(settledReads);
  await expect(reload).toContainText("Reload to see your saved memories.");
  await expect(library.getByText("Nothing saved yet")).toHaveCount(0);
  await expect(library.locator(".v2-memory-state")).toHaveCount(0);
  await expectNoMemoryFailure(page);

  failReads = false;
  await reload.getByRole("button", { name: "Reload" }).click();
  await expect(library.getByText("I prefer tea.", { exact: true })).toBeVisible();

  await library.getByRole("button", { name: "Memory actions: I prefer tea." }).click();
  await page.getByRole("menuitem", { name: "Forget" }).click();
  const confirm = library.getByRole("group", { name: "Forget I prefer tea.?" });
  await confirm.getByRole("button", { name: "Forget" }).click();
  await expect.poll(() => writes.length).toBe(1);
  await expect(confirm.getByRole("button", { name: "Forget" })).toBeEnabled();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(library.getByText("I prefer tea.", { exact: true })).toBeVisible();
  await expect(library.getByRole("button", { name: "Edit", exact: true })).toBeEnabled();
  await expect(library.getByRole("button", { name: "Add memory", exact: true }).first()).toBeEnabled();

  const memorySwitch = library.getByRole("switch", { name: "Search past chats: on" });
  await memorySwitch.click();
  await expect.poll(() => patches).toBe(1);
  await expect(library.getByRole("switch", { name: "Search past chats: on" })).toBeEnabled();
  for (const control of await library.getByRole("switch").all()) await expect(control).toBeEnabled();
  await expect(library.getByTestId("settings-memory-status")).toHaveCount(0);
  await expectNoMemoryFailure(page);
  await expectNoHorizontalOverflow(page);
});
