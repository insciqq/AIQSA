import { Prisma } from "@prisma/client";
import { lockUserPromptDefaultsExclusive } from "../prompts/promptDefaultsLock";
import type {
  SettingsValidationModel,
  UserSettingsRecord,
  UserSettingsUpdate,
  UserSettingsUpdateResult
} from "./handlers";

export type SettingsTransactionClient = Pick<
  Prisma.TransactionClient,
  "$queryRaw" | "promptPreset" | "userSettings"
>;

type LockedSettingsRow = {
  defaultControlValues: unknown;
  defaultModelId: string;
  defaultProvider: string;
  defaultSearchStrategyId: string;
  id: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeSettings(settings: {
  defaultControlValues: unknown;
  defaultModelId: string;
  defaultPromptPresetId: string | null;
  defaultProvider: string;
  defaultSearchStrategyId: string;
  showCitations: boolean;
  showReasoningBlocks: boolean;
  showToolActivity: boolean;
}): UserSettingsRecord {
  return {
    defaultControlValues: settings.defaultControlValues,
    defaultModelId: settings.defaultModelId,
    defaultPromptPresetId: settings.defaultPromptPresetId,
    defaultProvider: settings.defaultProvider,
    defaultSearchStrategyId: settings.defaultSearchStrategyId,
    showCitations: settings.showCitations,
    showReasoningBlocks: settings.showReasoningBlocks,
    showToolActivity: settings.showToolActivity
  };
}

function settingsUpdateData(
  update: UserSettingsUpdate,
  currentControlValues: unknown
): Prisma.UserSettingsUpdateInput {
  const { defaultControlValues, ...rest } = update;
  const data: Prisma.UserSettingsUpdateInput = { ...rest };

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
    Object.prototype.hasOwnProperty.call(update, "defaultModelId") ||
    Object.prototype.hasOwnProperty.call(update, "defaultProvider") ||
    Object.prototype.hasOwnProperty.call(update, "defaultSearchStrategyId")
  );
}

function validDefaultSelection(
  current: LockedSettingsRow,
  update: UserSettingsUpdate,
  validationModels: SettingsValidationModel[]
): boolean {
  const provider = update.defaultProvider ?? current.defaultProvider;
  const modelId = update.defaultModelId ?? current.defaultModelId;
  const searchStrategyId = update.defaultSearchStrategyId ?? current.defaultSearchStrategyId;
  const model = validationModels.find(
    (candidate) => candidate.provider === provider && candidate.modelId === modelId
  );

  return Boolean(model?.searchStrategyIds.includes(searchStrategyId));
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
      "id",
      "defaultControlValues",
      "defaultModelId",
      "defaultProvider",
      "defaultSearchStrategyId"
    FROM "UserSettings"
    WHERE "userId" = ${userId}
    FOR UPDATE
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
    where: {
      userId
    }
  });

  return {
    kind: "updated",
    settings: serializeSettings(settings)
  };
}
