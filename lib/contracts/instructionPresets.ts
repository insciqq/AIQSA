export const INSTRUCTION_PRESET_NAME_MAX_LENGTH = 80;
export const SYSTEM_INSTRUCTIONS_MAX_LENGTH = 32_000;
export const RESPONSE_REMINDER_MAX_LENGTH = 4_000;
export const INSTRUCTION_PRESET_MAX_COUNT = 20;

export type InstructionPresetDraft = {
  name: string;
  systemInstructions: string;
  responseReminder: string;
};
export type InstructionPreset = InstructionPresetDraft & {
  id: string;
  revision: number;
  updatedAt: string;
};
export type InstructionPresetSummary = Pick<InstructionPreset, "id" | "name" | "revision" | "updatedAt"> & {
  firstLine: string;
};
export type InstructionPresetState = {
  activePresetId: string | null;
  selectionVersion: number;
  presets: InstructionPresetSummary[];
};
export type InstructionPresetMutation =
  | { action: "create"; value: InstructionPresetDraft }
  | { action: "update"; id: string; revision: number; value: InstructionPresetDraft }
  | { action: "delete"; id: string; revision: number }
  | { action: "select"; id: string | null; selectionVersion: number };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && !value.includes("\0");
}
function id(value: unknown): value is string {
  return text(value, 128) && value.length > 0;
}
function version(value: unknown, minimum = 1): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}
function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).length === allowed.length && Object.keys(value).every((key) => allowed.includes(key));
}
export function decodeInstructionPresetDraft(value: unknown): InstructionPresetDraft | null {
  if (!record(value) || !keys(value, ["name", "systemInstructions", "responseReminder"]) ||
    !text(value.name, INSTRUCTION_PRESET_NAME_MAX_LENGTH) || !value.name.trim() ||
    !text(value.systemInstructions, SYSTEM_INSTRUCTIONS_MAX_LENGTH) ||
    !text(value.responseReminder, RESPONSE_REMINDER_MAX_LENGTH)) return null;
  return { name: value.name.trim(), systemInstructions: value.systemInstructions, responseReminder: value.responseReminder };
}
export function decodeInstructionPresetMutation(value: unknown): InstructionPresetMutation | null {
  if (!record(value)) return null;
  if (value.action === "select" && keys(value, ["action", "id", "selectionVersion"]) &&
    (value.id === null || id(value.id)) && version(value.selectionVersion, 0)) {
    return { action: "select", id: value.id, selectionVersion: value.selectionVersion };
  }
  if (value.action === "delete" && keys(value, ["action", "id", "revision"]) && id(value.id) && version(value.revision)) {
    return { action: "delete", id: value.id, revision: value.revision };
  }
  const draft = decodeInstructionPresetDraft(value.value);
  if (draft && value.action === "create" && keys(value, ["action", "value"])) return { action: "create", value: draft };
  if (draft && value.action === "update" && keys(value, ["action", "id", "revision", "value"]) && id(value.id) && version(value.revision)) {
    return { action: "update", id: value.id, revision: value.revision, value: draft };
  }
  return null;
}
export function decodeInstructionPreset(value: unknown): InstructionPreset | null {
  if (!record(value) || !keys(value, ["id", "name", "systemInstructions", "responseReminder", "revision", "updatedAt"]) ||
    !id(value.id) || !version(value.revision) || !text(value.updatedAt, 64) || !Number.isFinite(Date.parse(value.updatedAt))) return null;
  const draft = decodeInstructionPresetDraft({ name: value.name, systemInstructions: value.systemInstructions, responseReminder: value.responseReminder });
  return draft ? { ...draft, id: value.id, revision: value.revision, updatedAt: value.updatedAt } : null;
}
export function decodeInstructionPresetState(value: unknown): InstructionPresetState | null {
  if (!record(value) || !keys(value, ["activePresetId", "selectionVersion", "presets"]) ||
    !(value.activePresetId === null || id(value.activePresetId)) || !version(value.selectionVersion, 0) ||
    !Array.isArray(value.presets) || value.presets.length > INSTRUCTION_PRESET_MAX_COUNT) return null;
  const presets: InstructionPresetSummary[] = [];
  for (const entry of value.presets) {
    if (!record(entry) || !keys(entry, ["id", "name", "firstLine", "revision", "updatedAt"]) || !id(entry.id) ||
      !text(entry.name, INSTRUCTION_PRESET_NAME_MAX_LENGTH) || !entry.name.trim() || !text(entry.firstLine, 160) ||
      !version(entry.revision) || !text(entry.updatedAt, 64) || !Number.isFinite(Date.parse(entry.updatedAt))) return null;
    presets.push({ id: entry.id, name: entry.name, firstLine: entry.firstLine, revision: entry.revision, updatedAt: entry.updatedAt });
  }
  if (new Set(presets.map((entry) => entry.id)).size !== presets.length ||
    value.activePresetId !== null && !presets.some((entry) => entry.id === value.activePresetId)) return null;
  return { activePresetId: value.activePresetId, selectionVersion: value.selectionVersion, presets };
}

export function instructionPresetErrorMessage(code: unknown): string {
  switch (code) {
    case "instruction_preset_conflict": return "This preset was changed elsewhere. Reload it to see the latest version; your unsaved text is kept.";
    case "instruction_selection_conflict": return "The active preset was changed elsewhere. Refresh the list and try again.";
    case "instruction_preset_name_conflict": return "A preset with this name already exists. Choose another name.";
    case "instruction_preset_limit": return `You can save up to ${INSTRUCTION_PRESET_MAX_COUNT} presets.`;
    case "instruction_preset_invalid": return "Check the preset name and instruction lengths.";
    case "instruction_preset_not_found": return "This preset is no longer available. Your unsaved text is kept.";
    default: return "Instructions are unavailable right now. Your unsaved text is kept. Try again.";
  }
}
