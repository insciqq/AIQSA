import type { Page, Route } from "@playwright/test";
import {
  decodeOptionalChatDefaults,
  INSTALLATION_CHAT_DEFAULTS
} from "../../../lib/contracts/chatDefaults";
import type { UserSettingsWire } from "../../../lib/contracts/settings";
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
    if (value.contextStats === undefined) {
      chat.contextStats = { approximateActiveBranchInputTokens: 0 };
    }
    if (value.pageInfo === undefined) {
      const firstMessage = value.messages[0];
      const firstParentId = isRecord(firstMessage) && typeof firstMessage.parentMessageId === "string"
        ? firstMessage.parentMessageId
        : null;
      chat.pageInfo = {
        activeLeafMessageId:
          typeof value.activeLeafMessageId === "string" ? value.activeLeafMessageId : null,
        beforeCursor: firstParentId ? "fixture-before" : null,
        hasOlder: Boolean(firstParentId),
        snapshotUpdatedAt:
          typeof value.updatedAt === "string" ? value.updatedAt : "2026-06-10T00:00:00.000Z"
      };
    }
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
  const fixtureDefaults = fixtureCatalog.defaults as Record<string, unknown>;
  const chatDefaults = decodeOptionalChatDefaults({
    knowledgePlan: fixtureDefaults.knowledgePlan,
    mcpMode: fixtureDefaults.mcpMode,
    sendWithEnter: fixtureDefaults.sendWithEnter
  }) ?? INSTALLATION_CHAT_DEFAULTS;
  const settings: UserSettingsWire = {
    defaultControlValues: structuredClone(fixtureCatalog.defaults.controlValues),
    defaultKnowledgePlan: chatDefaults.knowledgePlan,
    defaultMcpMode: chatDefaults.mcpMode,
    hasPersonalModelDefault: fixtureCatalog.defaults.hasPersonalModelDefault,
    modelPreferenceSource: fixtureCatalog.defaults.modelPreferenceSource,
    organizationModelDefault: structuredClone(fixtureCatalog.defaults.organizationModelDefault),
    personalModelDefault: structuredClone(fixtureCatalog.defaults.personalModelDefault),
    defaultSearchPlan: structuredClone(fixtureCatalog.defaults.searchPlan),
    organizationSearchPlan: structuredClone(fixtureCatalog.defaults.organizationSearchPlan),
    searchPreferenceSource: fixtureCatalog.defaults.searchPreferenceSource,
    sendWithEnter: chatDefaults.sendWithEnter,
    showCitations: fixtureCatalog.defaults.showCitations,
    showReasoningBlocks: fixtureCatalog.defaults.showReasoningBlocks
  };
  await page.route("**/api/me/catalog", async (route) => {
    const effectiveModelDefault = settings.personalModelDefault ?? settings.organizationModelDefault;
    await route.fulfill({
      contentType: "application/json",
      json: {
        catalog: {
          ...fixtureCatalog,
          defaults: {
            ...fixtureCatalog.defaults,
            controlValues: settings.defaultControlValues,
            hasPersonalModelDefault: settings.hasPersonalModelDefault,
            modelId: effectiveModelDefault?.modelId ?? "",
            modelPreferenceSource: settings.modelPreferenceSource,
            organizationSearchPlan: settings.organizationSearchPlan,
            organizationModelDefault: settings.organizationModelDefault,
            personalModelDefault: settings.personalModelDefault,
            provider: effectiveModelDefault?.provider ?? "",
            searchPlan: settings.defaultSearchPlan,
            searchPreferenceSource: settings.searchPreferenceSource,
            showCitations: settings.showCitations,
            showReasoningBlocks: settings.showReasoningBlocks
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
    if (Object.prototype.hasOwnProperty.call(body, "defaultProviderModelId")) {
      if (body.defaultProviderModelId === null) {
        settings.personalModelDefault = null;
        settings.hasPersonalModelDefault = false;
        settings.modelPreferenceSource = settings.organizationModelDefault ? "organization" : "none";
      } else if (typeof body.defaultProviderModelId === "string") {
        const model = fixtureCatalog.models.find(
          (candidate) => candidate.modelId === body.defaultProviderModelId
        );
        if (model) {
          settings.personalModelDefault = { modelId: model.modelId, provider: model.provider };
          settings.hasPersonalModelDefault = true;
          settings.modelPreferenceSource = "personal";
        }
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, "defaultSearchPlan")) {
      if (body.defaultSearchPlan === null) {
        settings.defaultSearchPlan = structuredClone(settings.organizationSearchPlan);
        settings.searchPreferenceSource = "organization";
      } else if (body.defaultSearchPlan && typeof body.defaultSearchPlan === "object") {
        settings.defaultSearchPlan = body.defaultSearchPlan as typeof settings.defaultSearchPlan;
        settings.searchPreferenceSource = "personal";
      }
    }
    if (typeof body.showCitations === "boolean") {
      settings.showCitations = body.showCitations;
    }
    if (typeof body.showReasoningBlocks === "boolean") {
      settings.showReasoningBlocks = body.showReasoningBlocks;
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
