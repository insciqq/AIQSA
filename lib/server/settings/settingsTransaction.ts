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
  defaultProviderModelId: string | null;
  defaultSearchPlan: unknown;
  id: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeSettings(settings: {
  defaultControlValues: unknown;
  defaultKnowledgePlan: unknown;
  defaultMcpMode: string;
  defaultProviderModel: { id: string } | null;
  defaultSearchPlan: unknown;
  sendWithEnter: boolean;
  showCitations: boolean;
  showReasoningBlocks: boolean;
}): UserSettingsRecord {
  const defaultProviderModelId = settings.defaultProviderModel?.id ?? null;
  return {
    defaultControlValues: settings.defaultControlValues,
    defaultKnowledgePlan: settings.defaultKnowledgePlan,
    defaultMcpMode: settings.defaultMcpMode,
    defaultProviderModelId,
    defaultSearchPlan: settings.defaultSearchPlan,
    sendWithEnter: settings.sendWithEnter,
    showCitations: settings.showCitations,
    showReasoningBlocks: settings.showReasoningBlocks
  };
}

function settingsUpdateData(
  update: UserSettingsUpdate,
  currentControlValues: unknown
): Prisma.UserSettingsUpdateInput {
  const {
    defaultControlValues,
    defaultKnowledgePlan,
    defaultProviderModelId,
    defaultSearchPlan,
    ...rest
  } = update;
  const updatesSearchPlan = Object.prototype.hasOwnProperty.call(update, "defaultSearchPlan");
  const normalizedSearchPlan = updatesSearchPlan ? defaultSearchPlan : undefined;
  const updatesKnowledgePlan = Object.prototype.hasOwnProperty.call(update, "defaultKnowledgePlan");
  const data: Prisma.UserSettingsUpdateInput = {
    ...rest,
    ...(updatesSearchPlan && normalizedSearchPlan === null
      ? { defaultSearchPlan: Prisma.DbNull }
      : normalizedSearchPlan !== undefined
      ? { defaultSearchPlan: normalizedSearchPlan as Prisma.InputJsonObject }
      : {}),
    ...(updatesKnowledgePlan
      ? {
          defaultKnowledgePlan: defaultKnowledgePlan
            ? (defaultKnowledgePlan as unknown as Prisma.InputJsonObject)
            : Prisma.DbNull
        }
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
    Object.prototype.hasOwnProperty.call(update, "defaultSearchPlan")
  );
}

function invalidDefaultSelection(
  update: UserSettingsUpdate,
  validationModels: SettingsValidationModel[]
): "default_model_unavailable" | "default_search_unavailable" | null {
  const updatesModel = Object.prototype.hasOwnProperty.call(update, "defaultProviderModelId");
  if (updatesModel && update.defaultProviderModelId !== null) {
    const model = validationModels.find((candidate) =>
      candidate.modelId === update.defaultProviderModelId);
    if (!model) return "default_model_unavailable";
  }

  const updatesSearchPlan = Object.prototype.hasOwnProperty.call(update, "defaultSearchPlan");
  if (!updatesSearchPlan) return null;
  if (updatesSearchPlan && update.defaultSearchPlan === null) return null;
  const decodedPlan = decodeSearchPlan(update.defaultSearchPlan);
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
      settings."defaultSearchPlan"
    FROM "UserSettings" AS settings
    WHERE settings."userId" = ${userId}
    FOR UPDATE OF settings
  `;
  if (!lockedSettings) {
    return { kind: "not_found" };
  }

  const invalidSelection = changesDefaultSelection(update)
    ? invalidDefaultSelection(update, validationModels)
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
      defaultKnowledgePlan: true,
      defaultMcpMode: true,
      defaultProviderModel: {
        select: {
          id: true
        }
      },
      defaultSearchPlan: true,
      sendWithEnter: true,
      showCitations: true,
      showReasoningBlocks: true
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
