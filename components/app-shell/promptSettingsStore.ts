import type { PromptPreset } from "@/components/app-shell/types";
import { create } from "zustand";

type StateUpdate<T> = T | ((current: T) => T);

export type PromptEditorDraft = {
  developerPrompt: string;
  id: string | null;
  name: string;
  systemPrompt: string;
};

export type PromptSettingsSnapshot = {
  deletePromptConfirmation: PromptPreset | null;
  promptSaving: boolean;
  settingsOpen: boolean;
  settingsPromptEditor: PromptEditorDraft;
};

export type PromptSettingsStore = PromptSettingsSnapshot & {
  closeSettings(): void;
  editSettingsPrompt(prompt: PromptPreset): void;
  newSettingsPrompt(): void;
  openSettings(prompt: PromptPreset | null): void;
  setDeletePromptConfirmation(prompt: PromptPreset | null): void;
  setPromptSaving(value: boolean): void;
  setSettingsPromptEditor(update: StateUpdate<PromptEditorDraft>): void;
  setSettingsPromptFromPreset(prompt: PromptPreset | null): void;
};

export function promptEditorFromPreset(prompt: PromptPreset | null): PromptEditorDraft {
  return {
    developerPrompt: prompt?.developerPrompt ?? "",
    id: prompt?.id ?? null,
    name: prompt?.name ?? "",
    systemPrompt: prompt?.systemPrompt ?? ""
  };
}

export function hasPromptEditorChanges(editor: PromptEditorDraft, prompts: PromptPreset[]): boolean {
  const original = editor.id ? prompts.find((prompt) => prompt.id === editor.id) ?? null : null;
  if (!original) {
    return Boolean(editor.name.trim() || editor.systemPrompt.trim() || editor.developerPrompt.trim());
  }

  return (
    editor.name !== original.name ||
    editor.systemPrompt !== original.systemPrompt ||
    editor.developerPrompt !== (original.developerPrompt ?? "")
  );
}

export const initialPromptSettingsSnapshot: PromptSettingsSnapshot = {
  deletePromptConfirmation: null,
  promptSaving: false,
  settingsOpen: false,
  settingsPromptEditor: promptEditorFromPreset(null)
};

function applyUpdate<T>(current: T, update: StateUpdate<T>): T {
  return typeof update === "function" ? (update as (value: T) => T)(current) : update;
}

export const usePromptSettingsStore = create<PromptSettingsStore>((set) => ({
  ...initialPromptSettingsSnapshot,
  closeSettings() {
    set({ settingsOpen: false });
  },
  editSettingsPrompt(prompt) {
    set({ settingsPromptEditor: promptEditorFromPreset(prompt) });
  },
  newSettingsPrompt() {
    set({ settingsPromptEditor: promptEditorFromPreset(null) });
  },
  openSettings(prompt) {
    set({
      settingsOpen: true,
      settingsPromptEditor: promptEditorFromPreset(prompt)
    });
  },
  setDeletePromptConfirmation(prompt) {
    set({ deletePromptConfirmation: prompt });
  },
  setPromptSaving(value) {
    set({ promptSaving: value });
  },
  setSettingsPromptEditor(update) {
    set((state) => ({
      settingsPromptEditor: applyUpdate(state.settingsPromptEditor, update)
    }));
  },
  setSettingsPromptFromPreset(prompt) {
    set({ settingsPromptEditor: promptEditorFromPreset(prompt) });
  }
}));

export function resetPromptSettingsStoreForTest() {
  usePromptSettingsStore.setState({
    ...initialPromptSettingsSnapshot,
    settingsPromptEditor: promptEditorFromPreset(null)
  });
}
