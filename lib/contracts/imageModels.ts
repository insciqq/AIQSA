/** Why a published image model cannot run now. Only withdrawal changes a choice. */
export const IMAGE_MODEL_UNAVAILABLE_REASONS = [
  "model_unavailable", "credential_unavailable", "verification_required", "parameters_invalid"
] as const;
export type ImageModelUnavailableReason = (typeof IMAGE_MODEL_UNAVAILABLE_REASONS)[number];

/** A published image model as every user sees it; parameters stay with the administrator. */
export type UserImageModelOption = Readonly<{
  id: string;
  displayName: string;
  providerName: string;
  generation: boolean;
  editing: boolean;
  /** Null while the model can run with the administrator's parameters. */
  unavailableReason: ImageModelUnavailableReason | null;
}>;

export type UserImageModelSettings = Readonly<{
  models: readonly UserImageModelOption[];
  /** The administrator default; null when no image model is published. */
  organizationDefaultId: string | null;
  /** The user's own choice; null follows the organization default. */
  selectedId: string | null;
  effective: Readonly<{ id: string; source: "organization" | "personal" }> | null;
}>;

export const USER_IMAGE_MODEL_LIST_LIMIT = 256;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

export function isImageModelUnavailableReason(value: unknown): value is ImageModelUnavailableReason {
  return (IMAGE_MODEL_UNAVAILABLE_REASONS as readonly unknown[]).includes(value);
}

function option(value: unknown): value is UserImageModelOption {
  return record(value) && boundedText(value.id, 256) && boundedText(value.displayName, 160) &&
    boundedText(value.providerName, 160) && typeof value.generation === "boolean" && typeof value.editing === "boolean" &&
    (value.unavailableReason === null || isImageModelUnavailableReason(value.unavailableReason));
}

export function decodeUserImageModelSettings(value: unknown): UserImageModelSettings | null {
  if (!record(value) || !Array.isArray(value.models) || value.models.length > USER_IMAGE_MODEL_LIST_LIMIT ||
    !value.models.every(option)) return null;
  const models = value.models as UserImageModelOption[];
  const ids = new Set(models.map((model) => model.id));
  const reference = (entry: unknown): entry is string | null => entry === null || typeof entry === "string" && ids.has(entry);
  if (ids.size !== models.length || !reference(value.organizationDefaultId) || !reference(value.selectedId)) return null;
  const effectiveId = value.selectedId ?? value.organizationDefaultId;
  const effective = value.effective;
  if (effectiveId === null ? effective !== null : !record(effective) || effective.id !== effectiveId ||
    effective.source !== (value.selectedId === null ? "organization" : "personal")) return null;
  return {
    models: models.map((model) => ({ id: model.id, displayName: model.displayName, providerName: model.providerName,
      generation: model.generation, editing: model.editing, unavailableReason: model.unavailableReason })),
    organizationDefaultId: value.organizationDefaultId,
    selectedId: value.selectedId,
    effective: effectiveId === null ? null : { id: effectiveId, source: value.selectedId === null ? "organization" : "personal" }
  };
}

/** Whether the effective image model can edit images now, as the server resolved it. */
export function effectiveImageEditing(settings: UserImageModelSettings): boolean {
  const effective = settings.effective ? settings.models.find((model) => model.id === settings.effective?.id) : undefined;
  return effective?.unavailableReason === null && effective.editing;
}

/** Whether choosing a published image model would give personal chats image editing now. */
export function imageEditingChoiceAvailable(settings: UserImageModelSettings): boolean {
  return settings.models.some((model) => model.editing && model.unavailableReason === null);
}

/** The only accepted save body: a published model, or null to follow the organization default. */
export function decodeUserImageModelChoice(value: unknown): { providerModelId: string | null } | null {
  if (!record(value) || Object.keys(value).length !== 1 ||
    !(value.providerModelId === null || boundedText(value.providerModelId, 256) && value.providerModelId.trim() === value.providerModelId)) return null;
  return { providerModelId: value.providerModelId };
}

export function userImageModelErrorMessage(code: unknown): string {
  switch (code) {
    case "image_model_not_published": return "This image model is no longer published. Choose another model or the organization default.";
    case "image_model_input_invalid": return "Choose one of the listed image models.";
    default: return "Image models are unavailable. Try again.";
  }
}
