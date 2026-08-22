import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  expectWithinViewport
} from "./support/layoutAssertions";
import { chooseReasoningEffort } from "./shell/composer";
import { runAccountMenuAction } from "./shell/page";
import { assistantContentWithText } from "./shell/thread";

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
    revision: {
      name: string;
      revisionNumber: number;
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
  await page.addInitScript(() => {
    window.localStorage.removeItem("aiqsa.activeChatId");
  });
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
      developerPrompt: null,
      knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
      mcpServerIds: [],
      name: input.name,
      providerModelId: input.providerModelId,
      runControls: { reasoningEffort: "medium" },
      searchPlan: { mode: "all_selected", optionIds: [] },
      starterPrompts: input.starterPrompts ?? [],
      systemPrompt: input.systemPrompt ?? "You are terse."
    }
  });
  expect(response.status(), await response.text()).toBe(201);
  const body = (await response.json()) as AssistantDetailBody;
  return { id: body.assistant.id, name: body.assistant.revision.name };
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

async function waitForActiveChatId(page: Page): Promise<string> {
  let chatId: string | null = null;
  await expect
    .poll(async () => {
      chatId = await page.evaluate(() => window.localStorage.getItem("aiqsa.activeChatId"));
      return chatId;
    })
    .not.toBeNull();

  return chatId!;
}

async function deleteChat(page: Page, chatId: string | null): Promise<void> {
  if (chatId) {
    await page.request.delete(`/api/chats/${chatId}`, { timeout: 5_000 }).catch(() => undefined);
  }
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

async function selectAssistantFromPicker(page: Page, assistantId: string): Promise<void> {
  await page.getByRole("button", { name: "Capabilities" }).click();
  await page
    .getByRole("menu", { name: "Capabilities" })
    .getByRole("menuitemcheckbox", { name: /Use an Assistant/ })
    .click();
  const picker = page.getByTestId("assistant-picker");
  await expect(picker).toBeVisible();
  await picker.getByTestId(`assistant-picker-row-${assistantId}`).click();
  await expect(picker).toHaveCount(0);
  await expect(page.getByTestId("composer-v2-assistant-lock")).toBeVisible();
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

  await runAccountMenuAction(page, "Assistants");
  const library = page.getByTestId("library-v2");
  await expect(library).toBeVisible();
  await library.getByRole("button", { name: "New Assistant" }).click();

  const editorSurface = page.getByTestId("assistant-library");
  const editor = editorSurface.getByTestId("assistant-editor");
  await expect(editor).toBeVisible();
  await expect(editor.getByText("Draft", { exact: true })).toBeVisible();
  const save = editor.getByTestId("assistant-editor-save");
  await expect(save).toHaveText("Create assistant");
  await expect(save).toBeDisabled();

  await editor.getByLabel("Name", { exact: true }).fill(name);
  await editor.getByLabel("Model", { exact: true }).selectOption({ label: "Fake QSA" });
  await editor.getByLabel("System prompt").fill("You are terse.");
  await editor.getByRole("button", { name: "Starter prompts" }).click();
  await editor.getByRole("button", { name: "Add starter" }).click();
  await editor.getByLabel("Starter prompt 1", { exact: true }).fill("Say hello");

  await expect(save).toBeEnabled();
  await save.click();

  await expect(editorSurface.getByTestId("assistant-library-notice")).toContainText(
    "Assistant created. It stays private until you share it."
  );
  await expect(editor.getByText("Revision 1", { exact: true })).toBeVisible();
  await expect(editor.getByRole("heading", { name })).toBeVisible();
  await expect(save).toHaveText("Save revision");
  await expect(editor.getByRole("button", { name: "Use in chat" })).toBeVisible();

  await editor.getByRole("button", { name: "Back to assistants" }).click();
  await expect(editorSurface).toHaveCount(0);
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

  try {
    const library = await openAssistantsLibrary(page);
    const card = library.getByTestId(`assistant-card-${assistant.id}`);
    await expect(card).toContainText(name);
    await card.getByRole("button", { name: `Use ${name}` }).click();
    await expect(library).toHaveCount(0);

    const intro = page.getByTestId("assistant-blank-intro");
    await expect(intro).toBeVisible();
    await expect(intro).toContainText(name);
    const starter = intro
      .getByTestId("assistant-starter-prompts")
      .getByRole("button", { name: "Say hello" });
    await expect(starter).toBeVisible();
    await expect(page.getByTestId("composer-v2-assistant-lock")).toContainText(name);

    await starter.click();
    chatId = await waitForActiveChatId(page);
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
    for (const forbiddenKey of ["modelId", "params", "prompt", "provider", "timeZone"]) {
      expect(sendBody, forbiddenKey).not.toHaveProperty(forbiddenKey);
    }

    const identity = page
      .locator('article[data-role="assistant"]')
      .last()
      .getByTestId("answer-assistant-identity");
    await expect(identity).toBeVisible();
    await expect(identity).toContainText(name);
    await expect(identity).toContainText("revision 1");
    await expect(page.getByRole("button", { name: /^Run details/u })).toHaveCount(0);
  } finally {
    await deleteChat(page, chatId);
    await archiveAssistantById(page, assistant.id);
  }
});

test("requires explicit removal before a governed Assistant control changes", async ({ page }) => {
  const name = `${assistantNamePrefix} Strict ${Date.now()}`;
  const modelId = await fakeProviderModelId(page);
  const assistant = await createAssistantViaApi(page, { name, providerModelId: modelId });

  try {
    await selectAssistantFromPicker(page, assistant.id);
    const chip = page.getByTestId("composer-v2-assistant-lock");
    await expect(chip).toContainText(name);
    await expect(page.getByTestId("composer-assistant-removed-notice")).toHaveCount(0);

    await page.getByRole("button", { name: "Capabilities" }).click();
    const parameters = page
      .getByRole("menu", { name: "Capabilities" })
      .getByRole("menuitemcheckbox", { name: /Model parameters/ });
    await expect(parameters).toBeDisabled();
    await expect(parameters).toContainText("Managed by the Assistant");
    await page.getByRole("button", { name: "Close", exact: true }).click();

    await chip.getByRole("button", { name: "Remove" }).click();

    await expect(chip).toHaveCount(0);
    await expect(page.getByTestId("composer-assistant-removed-notice")).toHaveCount(0);
    await chooseReasoningEffort(page, "high");
    await expect(page.getByTestId("composer-v2-assistant-lock")).toHaveCount(0);
  } finally {
    await archiveAssistantById(page, assistant.id);
  }
});

test("keeps accepted answers on their historical revision after a revise", async ({ page }) => {
  const suffix = Date.now();
  const name = `${assistantNamePrefix} Revise ${suffix}`;
  const revisedName = `${assistantNamePrefix} Revise ${suffix} v2`;
  const question = `Historical identity check ${suffix}`;
  const modelId = await fakeProviderModelId(page);
  const assistant = await createAssistantViaApi(page, { name, providerModelId: modelId });
  let chatId: string | null = null;

  try {
    await selectAssistantFromPicker(page, assistant.id);
    await page.getByRole("textbox", { name: "Message" }).fill(question);
    await page.getByRole("textbox", { name: "Message" }).press("Enter");
    chatId = await waitForActiveChatId(page);
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
    await card.getByRole("menuitem", { name: "Edit" }).click();

    const editorSurface = page.getByTestId("assistant-library");
    const editor = editorSurface.getByTestId("assistant-editor");
    await expect(editor.getByText("Revision 1", { exact: true })).toBeVisible();
    const nameField = editor.getByLabel("Name", { exact: true });
    await expect(nameField).toHaveValue(name);
    await nameField.fill(revisedName);
    await editor.getByTestId("assistant-editor-save").click();
    await expect(editorSurface.getByTestId("assistant-library-notice")).toContainText("Saved revision 2");
    await expect(editor.getByText("Revision 2", { exact: true })).toBeVisible();

    await editor.getByRole("button", { name: "Back to assistants" }).click();
    await expect(editorSurface).toHaveCount(0);
    await library.getByRole("button", { name: "Back to chat" }).click();
    await expect(library).toHaveCount(0);

    // Historical immutability: the accepted answer keeps the revision it used.
    const identity = answer.getByTestId("answer-assistant-identity");
    await expect(identity).toContainText(name);
    await expect(identity).not.toContainText(revisedName);
    await expect(identity).toContainText("revision 1");
  } finally {
    await deleteChat(page, chatId);
    await archiveAssistantById(page, assistant.id);
  }
});

test("pins an assistant from the Library card and groups it in the quick picker", async ({ page }) => {
  const name = `${assistantNamePrefix} Pin ${Date.now()}`;
  const modelId = await fakeProviderModelId(page);
  const assistant = await createAssistantViaApi(page, { name, providerModelId: modelId });

  try {
    const library = await openAssistantsLibrary(page);
    const card = library.getByTestId(`assistant-card-${assistant.id}`);
    await card.getByRole("button", { name: `Pin ${name}` }).click();
    await expect(card.getByRole("button", { name: `Unpin ${name}` })).toBeVisible();
    await library.getByRole("button", { name: "Back to chat" }).click();
    await expect(library).toHaveCount(0);

    await page.getByRole("button", { name: "Capabilities" }).click();
    await page
      .getByRole("menu", { name: "Capabilities" })
      .getByRole("menuitemcheckbox", { name: /Use an Assistant/ })
      .click();
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

test("keeps the Library one-task and reachable at 390x844", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });

  await runAccountMenuAction(page, "Assistants");
  const library = page.getByTestId("library-v2");
  await expect(library).toBeVisible();
  await expect(library.getByRole("heading", { name: "Assistants" })).toBeVisible();
  await expect(library.getByRole("button", { name: "Back to chat" })).toBeInViewport();
  await expect(library.getByRole("button", { name: "New Assistant" })).toBeInViewport();
  await expectWithinViewport(page, library);
  await expectNoHorizontalOverflow(page);

  await library.getByRole("button", { name: "New Assistant" }).click();
  const editorSurface = page.getByTestId("assistant-library");
  const editor = editorSurface.getByTestId("assistant-editor");
  await expect(editor).toBeVisible();
  await expect(editor.getByRole("button", { name: "Back to assistants" })).toBeInViewport();
  await expect(editor.getByTestId("assistant-editor-save")).toBeInViewport();
  await expectNoHorizontalOverflow(page);

  await editor.getByRole("button", { name: "Back to assistants" }).click();
  await expect(editorSurface).toHaveCount(0);
  await expect(library.getByRole("button", { name: "Back to chat" })).toBeInViewport();
  await library.getByRole("button", { name: "Back to chat" }).click();
  await expect(library).toHaveCount(0);
});
