"use client";

import {
  clampedNumber,
  coerceReasoningEffort,
  coerceReasoningMode,
  defaultParameterControls
} from "@/components/app-shell/controlDefaults";
import { chatSummaryFromApi, messageFromApi } from "@/components/app-shell/shellApi";
import { isRecord } from "@/components/app-shell/shellValues";
import type {
  CatalogModel,
  CatalogSearchStrategy,
  ChatSummary,
  RunEventView,
  ThreadMessage
} from "@/components/app-shell/types";
import {
  decodeChatDetailResponse,
  decodeChatUpdateData,
  type ChatDetailWire as ApiChatDetail
} from "@/lib/contracts/chats";
import {
  reconcileSearchPlanSelection,
  resolveSearchStrategyId
} from "@/lib/domain/catalogMatrix";
import {
  decodeSearchPlan,
  SEARCH_DISABLED_STRATEGY_ID,
  type SearchPlan
} from "@/lib/domain/search";

const RESUME_POLL_HORIZON_MS = 5 * 60 * 1000;
const RESUME_POLL_INITIAL_DELAY_MS = 1500;
const RESUME_POLL_MAX_DELAY_MS = 30000;

type SavedControlDraft = {
  backgroundMode?: boolean;
  maxOutputTokens?: string;
  reasoningEffort?: string;
  reasoningMode?: string;
  searchStrategyId?: string;
  streamMode?: boolean;
  temperature?: string;
};

function chatDetailBodyFromUnknown(value: unknown): ApiChatDetail | null {
  return decodeChatDetailResponse(value);
}

function chatUpdateFromEvent(
  event: RunEventView
): {
  chat: ChatSummary;
  contextStats: ApiChatDetail["contextStats"];
  messages: ThreadMessage[];
  usageStats: ApiChatDetail["usageStats"];
} | null {
  if (event.type !== "chat_update") {
    return null;
  }

  const decoded = decodeChatUpdateData(event.data);
  if (!decoded) {
    return null;
  }

  return {
    chat: chatSummaryFromApi(decoded.chat),
    contextStats: decoded.chat.contextStats,
    messages: decoded.messages.map(messageFromApi),
    usageStats: decoded.chat.usageStats
  };
}

function modelControlKey(model: Pick<CatalogModel, "modelId" | "provider">): string {
  return `${model.provider}:${model.modelId}`;
}

function savedControlDraft(value: unknown): SavedControlDraft {
  if (!isRecord(value)) {
    return {};
  }

  return {
    ...(typeof value.backgroundMode === "boolean" ? { backgroundMode: value.backgroundMode } : {}),
    ...(typeof value.maxOutputTokens === "string" ? { maxOutputTokens: value.maxOutputTokens } : {}),
    ...(typeof value.reasoningEffort === "string" ? { reasoningEffort: value.reasoningEffort } : {}),
    ...(typeof value.reasoningMode === "string" ? { reasoningMode: value.reasoningMode } : {}),
    ...(typeof value.searchStrategyId === "string" ? { searchStrategyId: value.searchStrategyId } : {}),
    ...(typeof value.streamMode === "boolean" ? { streamMode: value.streamMode } : {}),
    ...(typeof value.temperature === "string" ? { temperature: value.temperature } : {})
  };
}

function resolveModelSearchStrategy(
  model:
    | (Pick<CatalogModel, "searchStrategyIds"> & Partial<Pick<CatalogModel, "modelId" | "provider">>)
    | null
    | undefined,
  controlValues?: Record<string, unknown>,
  fallbackSearchStrategyId?: string | null
): string {
  if (!model) {
    return resolveSearchStrategyId(model, fallbackSearchStrategyId);
  }

  const saved =
    typeof model.provider === "string" && typeof model.modelId === "string"
      ? savedControlDraft(controlValues?.[modelControlKey({ modelId: model.modelId, provider: model.provider })])
      : {};

  const preferred =
    saved.searchStrategyId && model.searchStrategyIds.includes(saved.searchStrategyId)
      ? saved.searchStrategyId
      : fallbackSearchStrategyId;

  return resolveSearchStrategyId(model, preferred);
}

function resolveModelSearchPlan(
  model: Pick<CatalogModel, "searchStrategyIds"> | null | undefined,
  preferredPlan: unknown,
  fallbackSearchStrategyId?: string | null,
  strategies?: readonly CatalogSearchStrategy[]
): SearchPlan {
  const decoded = decodeSearchPlan(preferredPlan, fallbackSearchStrategyId);
  if (!decoded.ok || !model) return { mode: "all_selected", optionIds: [] };
  const available = new Set(model.searchStrategyIds);
  const optionIds = decoded.plan.optionIds.filter((optionId) =>
    optionId !== SEARCH_DISABLED_STRATEGY_ID && available.has(optionId));
  return strategies
    ? reconcileSearchPlanSelection(optionIds, decoded.plan.mode, strategies)
    : { mode: decoded.plan.mode, optionIds };
}

function resolvePreferredSearchPlan(
  preferredPlan: unknown,
  fallbackSearchStrategyId?: string | null,
  strategies: readonly CatalogSearchStrategy[] = []
): SearchPlan {
  const decoded = decodeSearchPlan(preferredPlan, fallbackSearchStrategyId);
  if (!decoded.ok) return { mode: "all_selected", optionIds: [] };
  return reconcileSearchPlanSelection(decoded.plan.optionIds, decoded.plan.mode, strategies);
}

function resolveModelControlDefaults(
  model: CatalogModel,
  controlValues?: Record<string, unknown>
): Required<Omit<SavedControlDraft, "searchStrategyId">> {
  const controls = defaultParameterControls(model);
  const saved = savedControlDraft(controlValues?.[modelControlKey(model)]);
  const reasoningEffort = coerceReasoningEffort(
    saved.reasoningEffort ?? controls.reasoningEffort.defaultValue,
    controls
  );
  const reasoningMode = coerceReasoningMode(
    saved.reasoningMode ?? controls.reasoningMode?.defaultValue ?? "standard",
    controls
  );
  const maxOutputTokens =
    saved.maxOutputTokens !== undefined
      ? String(
          Math.round(
            clampedNumber(
              saved.maxOutputTokens,
              controls.maxOutputTokens.defaultValue,
              1,
              controls.maxOutputTokens.maxValue
            )
          )
        )
      : String(controls.maxOutputTokens.defaultValue);
  const temperature =
    saved.temperature !== undefined
      ? String(
          clampedNumber(
            saved.temperature,
            controls.temperature.defaultValue,
            controls.temperature.minValue,
            controls.temperature.maxValue
          )
        )
      : String(controls.temperature.defaultValue);

  return {
    backgroundMode:
      controls.background.supported &&
      (typeof saved.backgroundMode === "boolean" ? saved.backgroundMode : controls.background.defaultValue),
    maxOutputTokens,
    reasoningEffort,
    reasoningMode,
    streamMode:
      controls.stream.supported &&
      (typeof saved.streamMode === "boolean" ? saved.streamMode : controls.stream.defaultValue),
    temperature
  };
}

export {
  RESUME_POLL_HORIZON_MS,
  RESUME_POLL_INITIAL_DELAY_MS,
  RESUME_POLL_MAX_DELAY_MS,
  chatDetailBodyFromUnknown,
  chatUpdateFromEvent,
  modelControlKey,
  resolveModelControlDefaults,
  resolveModelSearchPlan,
  resolvePreferredSearchPlan,
  resolveModelSearchStrategy,
  savedControlDraft
};

export type { ApiChatDetail, SavedControlDraft };
