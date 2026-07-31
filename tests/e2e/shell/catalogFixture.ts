import type { Page, Route } from "@playwright/test";
import { matrixCatalog } from "./catalog";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeFixtureChat(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  const chat: Record<string, unknown> = { pinned: false, ...value };
  if (Array.isArray(value.messages)) {
    chat.messages = value.messages.map((message) =>
      isRecord(message)
        ? { createdAt: "2026-06-10T00:00:00.000Z", ...message }
        : message
    );
    if (value.usageStats === undefined) {
      chat.usageStats = null;
    }
  }
  return chat;
}

function normalizeFixtureWorkspace(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  return {
    contentMatches: [],
    ...value,
    ...(Array.isArray(value.chats)
      ? { chats: value.chats.map(normalizeFixtureChat) }
      : {})
  };
}

export async function installMatrixCatalogFixture(
  page: Page,
  workspace?: unknown,
  options: { catalog?: typeof matrixCatalog; onSettingsPatch?(): void } = {}
): Promise<void> {
  const fixtureCatalog = options.catalog ?? matrixCatalog;
  const fixtureWorkspace = normalizeFixtureWorkspace(
    workspace ?? { chats: [], contentMatches: [], folders: [] }
  );
  const settings = {
    defaultControlValues: structuredClone(fixtureCatalog.defaults.controlValues),
    defaultModelId: fixtureCatalog.defaults.modelId,
    defaultSearchPlan: structuredClone(fixtureCatalog.defaults.searchPlan),
    defaultPromptPresetId: fixtureCatalog.defaults.promptPresetId as string | null,
    defaultProvider: fixtureCatalog.defaults.provider,
    defaultSearchStrategyId: fixtureCatalog.defaults.searchStrategyId,
    organizationSearchPlan: structuredClone(fixtureCatalog.defaults.organizationSearchPlan),
    searchPreferenceSource: fixtureCatalog.defaults.searchPreferenceSource,
    showCitations: fixtureCatalog.defaults.showCitations,
    showReasoningBlocks: fixtureCatalog.defaults.showReasoningBlocks,
    showToolActivity: fixtureCatalog.defaults.showToolActivity
  };
  await page.route("**/api/me/catalog", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        catalog: {
          ...fixtureCatalog,
          defaults: {
            ...fixtureCatalog.defaults,
            controlValues: settings.defaultControlValues,
            modelId: settings.defaultModelId,
            organizationSearchPlan: settings.organizationSearchPlan,
            promptPresetId: settings.defaultPromptPresetId,
            provider: settings.defaultProvider,
            searchPlan: settings.defaultSearchPlan,
            searchPreferenceSource: settings.searchPreferenceSource,
            searchStrategyId: settings.defaultSearchStrategyId,
            showCitations: settings.showCitations,
            showReasoningBlocks: settings.showReasoningBlocks,
            showToolActivity: settings.showToolActivity
          }
        }
      }
    });
  });
  const fulfillChats = async (route: Route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      json: fixtureWorkspace
    });
  };
  await page.route("**/api/chats?*", fulfillChats);
  await page.route("**/api/chats", fulfillChats);
  if (isRecord(fixtureWorkspace) && Array.isArray(fixtureWorkspace.chats)) {
    for (const chat of fixtureWorkspace.chats) {
      if (!isRecord(chat) || typeof chat.id !== "string" || !Array.isArray(chat.messages)) {
        continue;
      }
      await page.route(`**/api/chats/${chat.id}`, async (route) => {
        if (route.request().method() !== "GET") {
          await route.continue();
          return;
        }
        await route.fulfill({ contentType: "application/json", json: { chat } });
      });
    }
  }
  await page.route("**/api/me/settings", async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }

    options.onSettingsPatch?.();
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    if (typeof body.defaultModelId === "string") {
      settings.defaultModelId = body.defaultModelId;
    }
    if (body.defaultPromptPresetId === null || typeof body.defaultPromptPresetId === "string") {
      settings.defaultPromptPresetId = body.defaultPromptPresetId;
    }
    if (typeof body.defaultProvider === "string") {
      settings.defaultProvider = body.defaultProvider;
    }
    if (Object.prototype.hasOwnProperty.call(body, "defaultSearchPlan")) {
      if (body.defaultSearchPlan === null) {
        settings.defaultSearchPlan = structuredClone(settings.organizationSearchPlan);
        settings.searchPreferenceSource = "organization";
      } else if (body.defaultSearchPlan && typeof body.defaultSearchPlan === "object") {
        settings.defaultSearchPlan = body.defaultSearchPlan as typeof settings.defaultSearchPlan;
        settings.searchPreferenceSource = "personal";
      }
      settings.defaultSearchStrategyId = settings.defaultSearchPlan?.optionIds[0] ?? "search-disabled";
    } else if (typeof body.defaultSearchStrategyId === "string") {
      settings.defaultSearchStrategyId = body.defaultSearchStrategyId;
    }
    if (typeof body.showCitations === "boolean") {
      settings.showCitations = body.showCitations;
    }
    if (typeof body.showReasoningBlocks === "boolean") {
      settings.showReasoningBlocks = body.showReasoningBlocks;
    }
    if (typeof body.showToolActivity === "boolean") {
      settings.showToolActivity = body.showToolActivity;
    }
    if (body.defaultControlValues && typeof body.defaultControlValues === "object") {
      settings.defaultControlValues = {
        ...settings.defaultControlValues,
        ...(body.defaultControlValues as Record<string, unknown>)
      };
    }

    await route.fulfill({
      contentType: "application/json",
      json: {
        settings: {
          ...settings,
          defaultSearchPlan: settings.defaultSearchPlan ?? { mode: "all_selected", optionIds: [] }
        }
      }
    });
  });
}
