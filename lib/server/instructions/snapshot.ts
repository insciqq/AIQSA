/** Instruction fields of private accepted requests. Historical requests omit
 * them; recovery never resolves mutable user settings as a fallback. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function onlyKnownKeys(value: Record<string, unknown>, keys: Set<string>) {
  return Object.keys(value).every(key => keys.has(key));
}
function nonBlank(value: unknown, max: number) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}
export function validAcceptedInstructions(value: Record<string, unknown>): boolean {
  if (!isRecord(value.prompt)) return false;
  for (const [key, limit] of [["personalInstructions", 32_000], ["responseReminder", 4_000]] as const) {
    const text = value.prompt[key];
    if (text !== undefined && (typeof text !== "string" || text.length > limit || text.includes("\0"))) return false;
  }
  const selection = value.instructionPreset;
  if (selection === undefined) return value.prompt.personalInstructions === undefined;
  if (!isRecord(selection) || !onlyKnownKeys(selection, new Set(["presetId", "revision", "selectionVersion"])) ||
    !Number.isSafeInteger(selection.selectionVersion) || Number(selection.selectionVersion) < 0 ||
    typeof value.prompt.personalInstructions !== "string" || typeof value.prompt.responseReminder !== "string") return false;
  return selection.presetId === null
    ? selection.revision === null && value.prompt.personalInstructions === "" && value.prompt.responseReminder === ""
    : nonBlank(selection.presetId, 128) && Number.isSafeInteger(selection.revision) && Number(selection.revision) > 0;
}
