import { Prisma } from "@prisma/client";
import { lockUserPromptDefaultsExclusive } from "../prompts/promptDefaultsLock";
import type {
  SettingsValidationModel,
  UserSettingsRecord,
  UserSettingsUpdate,
  UserSettingsUpdateResult
} from "./handlers";
import { decodeSearchPlan } from "../../domain/search";

export type SettingsTransactionClient = Pick<
  Prisma.TransactionClient,
  "$queryRaw" | "promptPreset" | "userSettings"
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
  defaultPromptPresetId: string | null;
  defaultSearchStrategyId: string;
  defaultSearchPlan: unknown;
  showCitations: boolean;
  showReasoningBlocks: boolean;
  showToolActivity: boolean;
}): UserSettingsRecord {
  const defaultProviderConnectionId = settings.defaultProviderModel?.connectionId ?? null;
  const defaultProviderModelId = settings.defaultProviderModel?.id ?? null;
  const decodedSearchPlan = decodeSearchPlan(
    settings.defaultSearchPlan,
    settings.defaultSearchStrategyId
  );

  return {
    defaultControlValues: settings.defaultControlValues,
    defaultModelId: defaultProviderModelId ?? "",
    defaultProviderConnectionId,
    defaultProviderModelId,
    defaultPromptPresetId: settings.defaultPromptPresetId,
    defaultProvider: defaultProviderConnectionId ?? "",
    defaultSearchStrategyId: settings.defaultSearchStrategyId,
    defaultSearchPlan: decodedSearchPlan.ok
      ? decodedSearchPlan.plan
      : { mode: "all_selected", optionIds: [] },
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
  const normalizedSearchPlan = defaultSearchPlan ?? (
    update.defaultSearchStrategyId !== undefined
      ? {
          mode: "all_selected" as const,
          optionIds: update.defaultSearchStrategyId === "search-disabled"
            ? []
            : [update.defaultSearchStrategyId]
        }
      : undefined
  );
  const data: Prisma.UserSettingsUpdateInput = {
    ...rest,
    ...(normalizedSearchPlan !== undefined
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

function validDefaultSelection(
  current: LockedSettingsRow,
  update: UserSettingsUpdate,
  validationModels: SettingsValidationModel[]
): boolean {
  const updatesModel = Object.prototype.hasOwnProperty.call(update, "defaultProviderModelId");
  const modelId = updatesModel
    ? update.defaultProviderModelId ?? null
    : current.defaultProviderModelId;
  if (!modelId) {
    return updatesModel && !Object.prototype.hasOwnProperty.call(update, "defaultSearchStrategyId");
  }

  const updatesLegacySearch = Object.prototype.hasOwnProperty.call(
    update,
    "defaultSearchStrategyId"
  );
  const decodedPlan = decodeSearchPlan(
    update.defaultSearchPlan ?? (updatesLegacySearch ? undefined : current.defaultSearchPlan),
    update.defaultSearchStrategyId ?? current.defaultSearchStrategyId
  );
  if (!decodedPlan.ok) return false;
  const model = validationModels.find(
    (candidate) =>
      candidate.modelId === modelId &&
      (updatesModel || candidate.provider === current.defaultProviderConnectionId)
  );

  return Boolean(model && decodedPlan.plan.optionIds.every((searchStrategyId) =>
    model.searchStrategyIds.includes(searchStrategyId)));
}

export async function applySettingsUpdateInTransaction(
  tx: SettingsTransactionClient,
  userId: string,
  update: UserSettingsUpdate,
  validationModels: SettingsValidationModel[]
): Promise<UserSettingsUpdateResult> {
  const hasPromptDefault = Object.prototype.hasOwnProperty.call(update, "defaultPromptPresetId");
  if (hasPromptDefault) {
    await lockUserPromptDefaultsExclusive(tx, userId);
  }

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

  if (
    changesDefaultSelection(update) &&
    !validDefaultSelection(lockedSettings, update, validationModels)
  ) {
    return {
      error: "default_search_unavailable",
      kind: "invalid"
    };
  }

  if (hasPromptDefault) {
    const defaultPromptPresetId = update.defaultPromptPresetId ?? null;
    if (defaultPromptPresetId) {
      const [prompt] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "PromptPreset"
        WHERE "id" = ${defaultPromptPresetId}
          AND "userId" = ${userId}
        FOR UPDATE
      `;

      if (!prompt) {
        return { kind: "not_found" };
      }
    }

    await tx.promptPreset.updateMany({
      data: {
        isDefault: false
      },
      where: {
        userId
      }
    });

    if (defaultPromptPresetId) {
      await tx.promptPreset.update({
        data: {
          isDefault: true
        },
        where: {
          id: defaultPromptPresetId
        }
      });
    }
  }

  const settings = await tx.userSettings.update({
    data: settingsUpdateData(update, lockedSettings.defaultControlValues),
    select: {
      defaultControlValues: true,
      defaultPromptPresetId: true,
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
