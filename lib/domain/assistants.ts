import type { AssistantRevisionContent } from "../contracts/assistants";

export type AssistantRevisionSection =
  | "identity"
  | "instructions"
  | "model"
  | "run-setup"
  | "search"
  | "starters"
  | "tools";

type ComparableRevision = Pick<
  AssistantRevisionContent,
  | "avatar"
  | "category"
  | "description"
  | "developerPrompt"
  | "mcpServerIds"
  | "name"
  | "providerModelId"
  | "runControls"
  | "searchPlan"
  | "starterPrompts"
  | "systemPrompt"
>;

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : entry
  );
}

/**
 * Pure semantic diff between two adjacent revisions, used by the read-only
 * Version history. Sections mirror the editor's bounded groups.
 */
export function assistantRevisionChangedSections(
  previous: ComparableRevision | null,
  next: ComparableRevision
): AssistantRevisionSection[] {
  if (!previous) {
    return ["identity", "instructions", "model", "run-setup", "search", "starters", "tools"];
  }

  const changed: AssistantRevisionSection[] = [];
  if (
    previous.name !== next.name ||
    previous.description !== next.description ||
    previous.category !== next.category ||
    stable(previous.avatar) !== stable(next.avatar)
  ) {
    changed.push("identity");
  }
  if (
    previous.systemPrompt !== next.systemPrompt ||
    previous.developerPrompt !== next.developerPrompt
  ) {
    changed.push("instructions");
  }
  if (previous.providerModelId !== next.providerModelId) {
    changed.push("model");
  }
  if (stable(previous.runControls) !== stable(next.runControls)) {
    changed.push("run-setup");
  }
  if (stable(previous.searchPlan) !== stable(next.searchPlan)) {
    changed.push("search");
  }
  if (stable(previous.starterPrompts) !== stable(next.starterPrompts)) {
    changed.push("starters");
  }
  if (stable([...previous.mcpServerIds].sort()) !== stable([...next.mcpServerIds].sort())) {
    changed.push("tools");
  }
  return changed;
}
