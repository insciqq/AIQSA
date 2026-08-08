import { Prisma } from "@prisma/client";
import type {
  SettingsValidationModel,
  UserSettingsRecord,
  UserSettingsUpdate,
  UserSettingsUpdateResult
} from "./handlers";
import { decodeSearchPlan } from "../../domain/search";

export type SettingsTransactionClient = Pick<
  Prisma.TransactionClient,
  "$queryRaw" | "userSettings"
>;

type LockedSettingsRow = {
  defaultControlValues: unknown;
  defaultProviderConnectionId: string | null;
  defaultProviderModelId: string | null;
  defaultSearchStrategyId: string;
  defaultSearchPlan: unknown;
  id: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeSettings(settings: {
  defaultControlValues: unknown;
  defaultProviderModel: {
    connectionId: string;
    id: string;
  } | null;
  defaultSearchStrategyId: string;
  defaultSearchPlan: unknown;
  showCitations: boolean;
  showReasoningBlocks: boolean;
  showToolActivity: boolean;
}): UserSettingsRecord {
  const defaultProviderConnectionId = settings.defaultProviderModel?.connectionId ?? null;
  const defaultProviderModelId = settings.defaultProviderModel?.id ?? null;
  return {
    defaultControlValues: settings.defaultControlValues,
    defaultModelId: defaultProviderModelId ?? "",
    defaultProviderConnectionId,
    defaultProviderModelId,
    defaultProvider: defaultProviderConnectionId ?? "",
    defaultSearchStrategyId: settings.defaultSearchStrategyId,
    defaultSearchPlan: settings.defaultSearchPlan,
    showCitations: settings.showCitations,
    showReasoningBlocks: settings.showReasoningBlocks,
    showToolActivity: settings.showToolActivity
  };
}

function settingsUpdateData(
  update: UserSettingsUpdate,
  currentControlValues: unknown
): Prisma.UserSettingsUpdateInput {
  const { defaultControlValues, defaultProviderModelId, defaultSearchPlan, ...rest } = update;
  const updatesSearchPlan = Object.prototype.hasOwnProperty.call(update, "defaultSearchPlan");
  const normalizedSearchPlan = updatesSearchPlan
    ? defaultSearchPlan
    : update.defaultSearchStrategyId !== undefined
      ? {
          mode: "all_selected" as const,
          optionIds: update.defaultSearchStrategyId === "search-disabled"
            ? []
            : [update.defaultSearchStrategyId]
        }
      : undefined;
  const data: Prisma.UserSettingsUpdateInput = {
    ...rest,
    ...(updatesSearchPlan && normalizedSearchPlan === null
      ? { defaultSearchPlan: Prisma.DbNull }
      : normalizedSearchPlan !== undefined
      ? { defaultSearchPlan: normalizedSearchPlan as Prisma.InputJsonObject }
      : {}),
    ...(typeof defaultProviderModelId !== "undefined"
      ? {
          defaultProviderModel: defaultProviderModelId
            ? { connect: { id: defaultProviderModelId } }
            : { disconnect: true }
        }
      : {})
  };

  if (defaultControlValues !== undefined) {
    const current = isRecord(currentControlValues) ? currentControlValues : {};
    const merged = { ...current };

    for (const [key, value] of Object.entries(defaultControlValues)) {
      merged[key] =
        isRecord(current[key]) && isRecord(value)
          ? {
              ...current[key],
              ...value
            }
          : value;
    }

    data.defaultControlValues = merged as Prisma.InputJsonObject;
  }

  return data;
}

function changesDefaultSelection(update: UserSettingsUpdate): boolean {
  return (
    Object.prototype.hasOwnProperty.call(update, "defaultProviderModelId") ||
    Object.prototype.hasOwnProperty.call(update, "defaultSearchStrategyId") ||
    Object.prototype.hasOwnProperty.call(update, "defaultSearchPlan")
  );
}

function invalidDefaultSelection(
  current: LockedSettingsRow,
  update: UserSettingsUpdate,
  validationModels: SettingsValidationModel[]
): "default_model_unavailable" | "default_search_unavailable" | null {
  const updatesModel = Object.prototype.hasOwnProperty.call(update, "defaultProviderModelId");
  if (updatesModel && update.defaultProviderModelId !== null) {
    const model = validationModels.find((candidate) =>
      candidate.modelId === update.defaultProviderModelId);
    if (!model) return "default_model_unavailable";
  }

  const updatesLegacySearch = Object.prototype.hasOwnProperty.call(
    update,
    "defaultSearchStrategyId"
  );
  const updatesSearchPlan = Object.prototype.hasOwnProperty.call(update, "defaultSearchPlan");
  if (!updatesLegacySearch && !updatesSearchPlan) return null;
  if (updatesSearchPlan && update.defaultSearchPlan === null) return null;
  const decodedPlan = decodeSearchPlan(
    updatesSearchPlan ? update.defaultSearchPlan : undefined,
    update.defaultSearchStrategyId ?? current.defaultSearchStrategyId
  );
  if (!decodedPlan.ok) return "default_search_unavailable";
  const availableSearchStrategyIds = new Set(validationModels.flatMap((model) =>
    model.searchStrategyIds));
  return decodedPlan.plan.optionIds.every((searchStrategyId) =>
    availableSearchStrategyIds.has(searchStrategyId))
    ? null
    : "default_search_unavailable";
}

export async function applySettingsUpdateInTransaction(
  tx: SettingsTransactionClient,
  userId: string,
  update: UserSettingsUpdate,
  validationModels: SettingsValidationModel[]
): Promise<UserSettingsUpdateResult> {
  const [lockedSettings] = await tx.$queryRaw<LockedSettingsRow[]>`
    SELECT
      settings."id",
      settings."defaultControlValues",
      settings."defaultProviderModelId",
      model."connectionId" AS "defaultProviderConnectionId",
      settings."defaultSearchStrategyId",
      settings."defaultSearchPlan"
    FROM "UserSettings" AS settings
    LEFT JOIN "ProviderModel" AS model
      ON model."id" = settings."defaultProviderModelId"
    WHERE settings."userId" = ${userId}
    FOR UPDATE OF settings
  `;
  if (!lockedSettings) {
    return { kind: "not_found" };
  }

  const invalidSelection = changesDefaultSelection(update)
    ? invalidDefaultSelection(lockedSettings, update, validationModels)
    : null;
  if (invalidSelection) {
    return {
      error: invalidSelection,
      kind: "invalid"
    };
  }

  const settings = await tx.userSettings.update({
    data: settingsUpdateData(update, lockedSettings.defaultControlValues),
    select: {
      defaultControlValues: true,
      defaultProviderModel: {
        select: {
          connectionId: true,
          id: true
        }
      },
      defaultSearchStrategyId: true,
      defaultSearchPlan: true,
      showCitations: true,
      showReasoningBlocks: true,
      showToolActivity: true
    },
    where: {
      userId
    }
  });

  return {
    kind: "updated",
    settings: serializeSettings(settings)
  };
}
