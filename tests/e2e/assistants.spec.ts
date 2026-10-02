import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  expectWithinViewport
} from "./support/layoutAssertions";
import { chooseReasoningEffort } from "./shell/composer";
import { runAccountMenuAction } from "./shell/page";
import { assistantContentWithText } from "./shell/thread";
import { e2eAssistantRows } from "./support/assistants";
import { setWorkspaceDefault } from "./support/chatDefaults";
import { activeChatId } from "./support/workspace";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";

test.describe.configure({ mode: "serial" });
test.setTimeout(60_000);

/**
 * Reusable Assistants coverage against the real dev stack and the seeded
 * deterministic Fake QSA provider. Assistant names are unique per run and
 * created assistants are archived afterwards so repeated runs against the
 * shared installation stay clean.
 */
const assistantNamePrefix = "E2E Reviewer";

type CatalogBody = {
  catalog: {
    models: {
      displayName: string;
      modelId: string;
      provider: string;
      providerFamily: string;
      upstreamModelId: string;
    }[];
  };
};

type AssistantSummaryBody = {
  archived: boolean;
  id: string;
  name: string;
  owned: boolean;
};

type AssistantListBody = {
  assistants: AssistantSummaryBody[];
};

type AssistantDetailBody = {
  assistant: {
    id: string;
    content: {
      name: string;
    };
    version?: number;
  };
};

/** A minimal valid generated-avatar recipe accepted by the strict decoder. */
const assistantAvatar = {
  accents: [0, 2],
  backgroundShape: "circle",
  foregroundShape: "diamond",
  kind: "generated",
  paletteId: "ocean",
  recipeVersion: 1,
  rotations: [0, 1]
} as const;

async function signIn(page: Page) {
  // `/` always opens a new chat.
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  const response = await page.request.post("/api/auth/token", {
    data: {
      token: "aiqsa-test-token"
    }
  });
  expect(response.ok()).toBe(true);
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();
}

async function fakeProviderModelId(page: Page): Promise<string> {
  const response = await page.request.get("/api/me/catalog");
  expect(response.ok()).toBe(true);
  const { catalog } = (await response.json()) as CatalogBody;
  const fakeModel = catalog.models.find(
    (model) => model.providerFamily === "fake" && model.upstreamModelId === "fake-qsa"
  );
  if (!fakeModel) {
    throw new Error("The deterministic Fake QSA model is missing from the seeded catalog");
  }
  return fakeModel.modelId;
}

async function createAssistantViaApi(
  page: Page,
  input: {
    name: string;
    providerModelId: string;
    starterPrompts?: string[];
    systemPrompt?: string;
  }
): Promise<{ id: string; name: string }> {
  const response = await page.request.post("/api/me/assistants", {
    data: {
      avatar: assistantAvatar,
      category: null,
      description: "",
      name: input.name,
      rows: e2eAssistantRows(input.providerModelId, {
        controls: { policy: "fixed", value: { reasoningEffort: "medium" } }
      }),
      starterPrompts: input.starterPrompts ?? [],
      systemPrompt: input.systemPrompt ?? "You are terse."
    }
  });
  expect(response.status(), await response.text()).toBe(201);
  const body = (await response.json()) as AssistantDetailBody;
  return { id: body.assistant.id, name: body.assistant.content.name };
}

async function archiveAssistantById(page: Page, assistantId: string): Promise<void> {
  const detailResponse = await page.request.get(`/api/me/assistants/${assistantId}`);
  if (!detailResponse.ok()) {
    return;
  }
  const detail = (await detailResponse.json()) as AssistantDetailBody;
  if (typeof detail.assistant.version !== "number") {
    return;
  }
  await page.request.patch(`/api/me/assistants/${assistantId}`, {
    data: { archived: true, expectedVersion: detail.assistant.version }
  });
}

/** Archives leftovers from earlier runs so shared-stack state stays bounded. */
async function archiveE2eAssistants(page: Page): Promise<void> {
  const response = await page.request.get("/api/me/assistants");
  if (!response.ok()) {
    return;
  }
  const body = (await response.json()) as AssistantListBody;
  for (const assistant of body.assistants) {
    if (assistant.owned && !assistant.archived && assistant.name.startsWith(assistantNamePrefix)) {
      await archiveAssistantById(page, assistant.id);
    }
  }
}

async function deleteChat(page: Page, chatId: string | null): Promise<void> {
  if (chatId) {
    await deleteOwnedChatPermanently(page.request, chatId, { timeout: 5_000 }).catch(() => undefined);
  }
}

/**
 * Sets the personal Workspace default and reloads so the next new chat uses
 * it: the Fake QSA window cannot hold the Workspace context the seeded default adds.
 */
async function setWorkspaceDefaultAndReload(page: Page, enabled: boolean): Promise<void> {
  await setWorkspaceDefault(page.request, enabled);
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();
}

async function openAssistantsLibrary(page: Page): Promise<Locator> {
  await runAccountMenuAction(page, "Assistants");
  const library = page.getByTestId("library-v2");
  await expect(library).toBeVisible();
  await expect(library.getByRole("tab", { name: "Assistants" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  return library;
}

/** The header selector opens the picker of a chat without an Assistant (the "+" entry is gone). */
async function selectAssistantFromPicker(page: Page, assistantId: string): Promise<void> {
  const selector = page.getByTestId("header-assistant-selector");
  await expect(selector).toHaveAttribute("data-state", "empty");
  await selector.click();
  const picker = page.getByTestId("assistant-picker");
  await expect(picker).toBeVisible();
  await picker.getByTestId(`assistant-picker-row-${assistantId}`).click();
  await expect(picker).toHaveCount(0);
  await expect(selector).toHaveAttribute("data-state", "chosen");
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await archiveE2eAssistants(page);
});

test.afterEach(async ({ page }) => {
  await archiveE2eAssistants(page);
});

test("creates an assistant through the Library editor", async ({ page }) => {
  const name = `${assistantNamePrefix} ${Date.now()}`;
  const modelId = await fakeProviderModelId(page);

  await runAccountMenuAction(page, "Assistants");
  const library = page.getByTestId("library-v2");
  await expect(library).toBeVisible();
  await library.getByRole("button", { exact: true, name: "New assistant" }).first().click();
  await page.getByRole("dialog", { name: "New assistant" }).getByRole("button", { name: "Continue" }).click();

  const editor = library.getByTestId("assistant-editor");
  await expect(editor).toBeVisible();
  await expect(editor.getByRole("heading", { name: "New assistant", exact: true })).toBeVisible();
  const save = editor.getByTestId("assistant-editor-save");
  await expect(save).toHaveText("Create");
  await expect(editor.getByRole("button", { name: "Adjustable", exact: true })).toHaveCount(6);

  await editor.getByLabel("Name Required", { exact: true }).fill(name);
  await editor.getByRole("button", { name: "Model", exact: true }).click();
  await editor.getByLabel("Model", { exact: true }).selectOption(modelId);
  await editor.getByRole("textbox", { name: "Instructions", exact: true }).fill("You are terse.");
  await editor.getByRole("button", { name: "Add starter" }).click();
  await editor.getByLabel("Conversation starter 1", { exact: true }).fill("Say hello");

  await save.click();

  await expect(editor.getByTestId("assistant-library-notice")).toContainText(
    "Assistant created. It stays private until you share it."
  );
  await expect(editor.getByRole("button", { exact: true, name: "Revision 1" })).toHaveCount(0);
  await expect(editor.getByRole("heading", { name })).toBeVisible();
  await expect(save).toHaveText("Save");
  await expect(editor.getByText("Saved", { exact: true })).toBeVisible();
  await expect(editor.getByRole("button", { name: "Manage sharing…" })).toBeEnabled();

  await library.getByRole("button", { exact: true, name: "Back to Assistants" }).click();
  await expect(editor).toHaveCount(0);
  await expect(library.getByRole("heading", { name })).toBeVisible();
  await library.getByRole("button", { name: "Back to chat" }).click();
  await expect(library).toHaveCount(0);
});

test("uses an assistant from the Library and completes an identified run", async ({ page }) => {
  const name = `${assistantNamePrefix} Run ${Date.now()}`;
  const modelId = await fakeProviderModelId(page);
  const assistant = await createAssistantViaApi(page, {
    name,
    providerModelId: modelId,
    starterPrompts: ["Say hello"],
    systemPrompt: "You are terse."
  });
  let chatId: string | null = null;
  const sendBodies: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /^\/api\/chats\/[^/]+\/messages$/u.test(new URL(request.url()).pathname)
    ) {
      sendBodies.push(request.postDataJSON() as Record<string, unknown>);
    }
  });

  await setWorkspaceDefaultAndReload(page, false);

  try {
    const library = await openAssistantsLibrary(page);
    const card = library.getByTestId(`assistant-card-${assistant.id}`);
    await expect(card).toContainText(name);
    await card.getByRole("button", { name: `Start chat with ${name}` }).click();
    await expect(library).toHaveCount(0);

    const starter = page
      .getByTestId("assistant-starter-prompts")
      .getByRole("button", { name: "Say hello" });
    await expect(starter).toBeVisible();
    await expect(page.getByTestId("header-assistant-selector")).toHaveAttribute("data-state", "chosen");

    await starter.click();
    chatId = await activeChatId(page);
    await expect(assistantContentWithText(page, "Fake answer: Say hello")).toBeVisible({
      timeout: 20_000
    });
    await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, {
      timeout: 20_000
    });

    expect(sendBodies).toHaveLength(1);
    const sendBody = sendBodies[0]!;
    expect(sendBody.assistantId).toBe(assistant.id);
    expect(sendBody.content).toBeTruthy();
    // An Assistant run renders its date and time in the user's zone.
    expect(typeof sendBody.timeZone).toBe("string");
    // No ordinary composer payload travels with an unchanged Assistant.
    for (const forbiddenKey of ["modelId", "params", "prompt", "provider"]) {
      expect(sendBody, forbiddenKey).not.toHaveProperty(forbiddenKey);
    }

    const identity = page
      .locator('article[data-role="assistant"]')
      .last()
      .getByTestId("answer-assistant-identity");
    await expect(identity).toBeVisible();
    await expect(identity).toContainText(name);
    // Revisions are not an ordinary UI concept: the identity shows the name only.
    await expect(identity).not.toContainText("revision");
    await expect(page.getByRole("button", { name: /^Run details/u })).toHaveCount(0);
  } finally {
    await deleteChat(page, chatId);
    await archiveAssistantById(page, assistant.id);
    await setWorkspaceDefaultAndReload(page, true);
  }
});

test("requires removing the Assistant before a fixed Assistant control changes", async ({ page }) => {
  const name = `${assistantNamePrefix} Strict ${Date.now()}`;
  const modelId = await fakeProviderModelId(page);
  const assistant = await createAssistantViaApi(page, { name, providerModelId: modelId });

  try {
    await selectAssistantFromPicker(page, assistant.id);
    const selector = page.getByTestId("header-assistant-selector");
    await expect(selector).toHaveAccessibleName(`Assistant: ${name}`);

    // The fixed model is locked with the Assistant's mark: its picker offers no model to choose.
    const modelTrigger = page.getByTestId("header-model-trigger");
    await expect(modelTrigger).toBeEnabled();
    await expect(modelTrigger).toHaveAttribute("data-locked", "true");
    await expect(modelTrigger).toHaveAttribute("data-provenance", "assistant");
    await expect(modelTrigger).toHaveAttribute("title", `Fake QSA · fixed by ${name}`);
    await modelTrigger.click();
    const modelPicker = page.getByRole("dialog", { name: "Choose model" });
    await expect(modelPicker.getByTestId("composer-v2-model-fixed")).toBeVisible();
    await expect(modelPicker.getByRole("option")).toHaveCount(0);
    await expect(modelPicker.getByRole("searchbox")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(modelPicker).toHaveCount(0);

    await selector.click();
    await page.getByRole("menu", { name: "Assistant" }).getByRole("menuitem", { name: /^Remove for this chat/ }).click();

    // Removal is explicit and nothing else changes silently: the model is the user's own again.
    await expect(selector).toHaveAttribute("data-state", "empty");
    await expect(modelTrigger).not.toHaveAttribute("data-locked", "true");
    await expect(modelTrigger).not.toHaveAttribute("data-provenance", "assistant");
    await chooseReasoningEffort(page, "high");
    await expect(selector).toHaveAttribute("data-state", "empty");
  } finally {
    await archiveAssistantById(page, assistant.id);
  }
});

test("keeps accepted answers on their historical identity after an edit", async ({ page }) => {
  const suffix = Date.now();
  const name = `${assistantNamePrefix} Revise ${suffix}`;
  const revisedName = `${assistantNamePrefix} Revise ${suffix} v2`;
  const question = `Historical identity check ${suffix}`;
  const modelId = await fakeProviderModelId(page);
  const assistant = await createAssistantViaApi(page, { name, providerModelId: modelId });
  let chatId: string | null = null;
  await setWorkspaceDefaultAndReload(page, false);

  try {
    await selectAssistantFromPicker(page, assistant.id);
    await page.getByRole("textbox", { name: "Message" }).fill(question);
    await page.getByRole("textbox", { name: "Message" }).press("Enter");
    chatId = await activeChatId(page);
    await expect(assistantContentWithText(page, `Fake answer: ${question}`)).toBeVisible({
      timeout: 20_000
    });
    await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, {
      timeout: 20_000
    });
    const answer = page.locator('article[data-role="assistant"]').last();
    await expect(answer.getByTestId("answer-assistant-identity")).toContainText(name);

    const library = await openAssistantsLibrary(page);
    const card = library.getByTestId(`assistant-card-${assistant.id}`);
    await card.getByRole("button", { name: `More actions for ${name}` }).click();
    await page.getByRole("menuitem", { exact: true, name: "Edit" }).click();

    const editor = library.getByTestId("assistant-editor");
    await expect(editor.getByRole("button", { exact: true, name: "Revision 1" })).toHaveCount(0);
    const nameField = editor.getByLabel("Name Required", { exact: true });
    await expect(nameField).toHaveValue(name);
    await nameField.fill(revisedName);
    await editor.getByTestId("assistant-editor-save").click();
    await expect(editor.getByTestId("assistant-library-notice")).toContainText("Saved. Future runs use these changes.");
    await expect(editor.getByRole("button", { exact: true, name: "Revision 2" })).toHaveCount(0);

    await library.getByRole("button", { exact: true, name: "Back to Assistants" }).click();
    await expect(editor).toHaveCount(0);
    await library.getByRole("button", { name: "Back to chat" }).click();
    await expect(library).toHaveCount(0);

    // Historical immutability: the accepted answer keeps its saved identity.
    const identity = answer.getByTestId("answer-assistant-identity");
    await expect(identity).toContainText(name);
    await expect(identity).not.toContainText(revisedName);
    await expect(identity).not.toContainText("revision");
  } finally {
    await deleteChat(page, chatId);
    await archiveAssistantById(page, assistant.id);
    await setWorkspaceDefaultAndReload(page, true);
  }
});

test("pins an assistant from the Library card and groups it in the quick picker", async ({ page }) => {
  const name = `${assistantNamePrefix} Pin ${Date.now()}`;
  const modelId = await fakeProviderModelId(page);
  const assistant = await createAssistantViaApi(page, { name, providerModelId: modelId });

  try {
    const library = await openAssistantsLibrary(page);
    const card = library.getByTestId(`assistant-card-${assistant.id}`);
    const pin = card.getByRole("button", { exact: true, name: `Pin ${name}` });
    await expect(pin).toHaveAttribute("aria-pressed", "false");
    await pin.click();
    await expect(pin).toHaveAttribute("aria-pressed", "true");
    await expect(library.getByRole("region", { name: "Pinned" }).getByTestId(`assistant-card-${assistant.id}`)).toBeVisible();
    await library.getByRole("button", { name: "Back to chat" }).click();
    await expect(library).toHaveCount(0);

    await page.getByTestId("header-assistant-selector").click();
    const picker = page.getByTestId("assistant-picker");
    await expect(picker).toBeVisible();
    const pinnedGroup = picker.locator('section[aria-label="Pinned"]');
    await expect(pinnedGroup.getByTestId(`assistant-picker-row-${assistant.id}`)).toBeVisible();
    await expect(pinnedGroup).toContainText(name);
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
  } finally {
    await archiveAssistantById(page, assistant.id);
  }
});

test("archives, restores and deletes an assistant from the gallery", async ({ page }) => {
  const name = `${assistantNamePrefix} Lifecycle ${Date.now()}`;
  const modelId = await fakeProviderModelId(page);
  const assistant = await createAssistantViaApi(page, { name, providerModelId: modelId });

  try {
    const library = await openAssistantsLibrary(page);
    const gallery = library.getByTestId("assistant-gallery");
    const card = gallery.getByTestId(`assistant-card-${assistant.id}`);
    await card.getByRole("button", { name: `More actions for ${name}` }).click();
    await page.getByRole("menuitem", { exact: true, name: "Archive" }).click();
    await expect(gallery.getByTestId("assistant-gallery-notice")).toContainText(`Archived ${name}.`);
    await expect(card).toHaveCount(0);

    await gallery.getByRole("button", { name: /^Archived \d+$/u }).click();
    await expect(card).toContainText("Archived");
    await expect(card.getByRole("button", { name: /^Start chat/u })).toHaveCount(0);
    await card.getByRole("button", { name: `Restore ${name}` }).click();
    await expect(gallery.getByTestId("assistant-gallery-notice")).toContainText(`Restored ${name}.`);
    await expect(card).toHaveCount(0);

    await gallery.getByRole("button", { name: /^All \d+$/u }).click();
    await card.getByRole("button", { exact: true, name }).click();
    const sheet = page.getByRole("dialog", { exact: true, name });
    await expect(sheet.getByRole("region", { name: "Setup" }).getByRole("row")).toHaveCount(6);
    await sheet.getByRole("button", { name: `More actions for ${name}` }).click();
    await page.getByRole("menuitem", { exact: true, name: "Delete" }).click();
    const confirm = page.getByRole("dialog", { name: `Delete “${name}”?` });
    await expect(confirm).toContainText("It isn't shared, used by a Project or bound to a chat.");
    await confirm.getByRole("button", { exact: true, name: "Delete" }).click();

    await expect(confirm).toHaveCount(0);
    await expect(sheet).toHaveCount(0);
    await expect(gallery.getByTestId("assistant-gallery-notice")).toContainText(`Deleted ${name}.`);
    await expect(card).toHaveCount(0);
    expect((await page.request.get(`/api/me/assistants/${assistant.id}`)).status()).toBe(404);
  } finally {
    await archiveAssistantById(page, assistant.id);
  }
});

test("keeps the Library one-task and reachable at 390x844", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });

  await runAccountMenuAction(page, "Assistants");
  const library = page.getByTestId("library-v2");
  await expect(library).toBeVisible();
  await expect(library.getByRole("heading", { exact: true, name: "Assistants" })).toBeVisible();
  await expect(library.getByRole("button", { name: "Back to chat" })).toBeInViewport();
  await expect(library.getByRole("button", { name: "New assistant", exact: true }).first()).toBeInViewport();
  await expectWithinViewport(page, library);
  await expectNoHorizontalOverflow(page);

  await library.getByRole("button", { exact: true, name: "New assistant" }).first().click();
  const sheet = page.getByRole("dialog", { name: "New assistant" });
  await expectWithinViewport(page, sheet);
  await sheet.getByRole("button", { name: "Continue" }).click();
  const editor = library.getByTestId("assistant-editor");
  await expect(editor).toBeVisible();
  await expect(library.getByRole("button", { exact: true, name: "Back to Assistants" })).toBeInViewport();
  await expect(editor.getByTestId("assistant-editor-save")).toBeInViewport();
  const starters = editor.getByRole("heading", { name: "Conversation starters" });
  const setup = editor.getByRole("complementary", { name: "Setup" });
  expect((await setup.boundingBox())!.y).toBeGreaterThan((await starters.boundingBox())!.y);
  await expectNoHorizontalOverflow(page);

  await library.getByRole("button", { exact: true, name: "Back to Assistants" }).click();
  await expect(editor).toHaveCount(0);
  await expect(library.getByRole("button", { name: "Back to chat" })).toBeInViewport();
  await library.getByRole("button", { name: "Back to chat" }).click();
  await expect(library).toHaveCount(0);
});

test("Save & try opens a Temporary chat and Edit Assistant returns to the editor", async ({ page }) => {
  const name = `${assistantNamePrefix} Try ${Date.now()}`;

  await runAccountMenuAction(page, "Assistants");
  const library = page.getByTestId("library-v2");
  await library.getByRole("button", { exact: true, name: "New assistant" }).first().click();
  await page.getByRole("dialog", { name: "New assistant" }).getByRole("button", { name: "Continue" }).click();
  const editor = library.getByTestId("assistant-editor");
  await editor.getByLabel("Name Required", { exact: true }).fill(name);
  await editor.getByLabel("Description", { exact: true }).fill("Tried from the editor.");
  await editor.getByRole("button", { name: "Save & try" }).click();

  await expect(library).toHaveCount(0);
  await expect(page.getByTestId("header-temporary-indicator")).toBeVisible();
  const selector = page.getByRole("button", { name: `Assistant: ${name}` });
  await expect(selector).toBeVisible();
  await selector.click();
  await page.getByRole("menu", { name: "Assistant" }).getByRole("menuitem", { name: "Edit Assistant" }).click();

  const reopened = page.getByTestId("library-v2").getByTestId("assistant-editor");
  await expect(reopened.getByLabel("Name Required", { exact: true })).toHaveValue(name);
  await expect(reopened.getByLabel("Description", { exact: true })).toHaveValue("Tried from the editor.");
  await expect(reopened.getByText("Saved", { exact: true })).toBeVisible();
});
