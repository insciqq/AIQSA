import { afterEach, describe, expect, it } from "vitest";
import type { PromptPreset } from "./types";
import {
  hasPromptEditorChanges,
  promptEditorFromPreset,
  resetPromptSettingsStoreForTest,
  usePromptSettingsStore
} from "./promptSettingsStore";

const prompts: PromptPreset[] = [
  {
    developerPrompt: null,
    id: "prompt-default",
    isDefault: true,
    name: "Helpful Assistant",
    systemPrompt: "Be helpful."
  },
  {
    developerPrompt: "Check assumptions.",
    id: "prompt-custom",
    isDefault: false,
    name: "Research Prompt",
    systemPrompt: "Research carefully."
  }
];

describe("prompt settings store", () => {
  afterEach(() => {
    resetPromptSettingsStoreForTest();
  });

  it("opens and edits the Settings prompt editor from prompt presets", () => {
    usePromptSettingsStore.getState().openSettings(prompts[0]);
    expect(usePromptSettingsStore.getState()).toMatchObject({
      settingsOpen: true,
      settingsPromptEditor: promptEditorFromPreset(prompts[0])
    });

    usePromptSettingsStore.getState().editSettingsPrompt(prompts[1]);
    expect(usePromptSettingsStore.getState().settingsPromptEditor).toEqual(promptEditorFromPreset(prompts[1]));

    usePromptSettingsStore.getState().newSettingsPrompt();
    expect(usePromptSettingsStore.getState().settingsPromptEditor).toEqual(promptEditorFromPreset(null));
  });

  it("detects dirty Settings drafts before close confirmation", () => {
    const pristineDraft = promptEditorFromPreset(prompts[0]);
    expect(pristineDraft).toEqual({
      developerPrompt: "",
      id: "prompt-default",
      name: "Helpful Assistant",
      systemPrompt: "Be helpful."
    });
    expect(hasPromptEditorChanges(pristineDraft, prompts)).toBe(false);

    for (const changedDraft of [
      { ...pristineDraft, name: "Changed" },
      { ...pristineDraft, systemPrompt: "Changed" },
      { ...pristineDraft, developerPrompt: "Changed" }
    ]) {
      expect(hasPromptEditorChanges(changedDraft, prompts)).toBe(true);
    }

    expect(
      hasPromptEditorChanges(
        {
          developerPrompt: "",
          id: null,
          name: "New prompt",
          systemPrompt: ""
        },
        prompts
      )
    ).toBe(true);

    expect(
      hasPromptEditorChanges(
        {
          developerPrompt: "  ",
          id: null,
          name: "  ",
          systemPrompt: "\n"
        },
        prompts
      )
    ).toBe(false);

    expect(
      hasPromptEditorChanges(
        {
          ...pristineDraft,
          id: "prompt-missing"
        },
        prompts
      )
    ).toBe(true);
  });

  it("supports direct and functional editor transitions without resetting unrelated Settings state", () => {
    usePromptSettingsStore.getState().openSettings(prompts[0]);
    usePromptSettingsStore.getState().setPromptSaving(true);
    usePromptSettingsStore.getState().setSettingsPromptEditor((editor) => ({
      ...editor,
      name: "Helpful Assistant v2"
    }));

    expect(usePromptSettingsStore.getState()).toMatchObject({
      promptSaving: true,
      settingsOpen: true,
      settingsPromptEditor: {
        developerPrompt: "",
        id: "prompt-default",
        name: "Helpful Assistant v2",
        systemPrompt: "Be helpful."
      }
    });

    usePromptSettingsStore.getState().setSettingsPromptFromPreset(prompts[1]);
    expect(usePromptSettingsStore.getState().settingsPromptEditor).toEqual(promptEditorFromPreset(prompts[1]));

    usePromptSettingsStore.getState().closeSettings();
    expect(usePromptSettingsStore.getState()).toMatchObject({
      promptSaving: true,
      settingsOpen: false,
      settingsPromptEditor: promptEditorFromPreset(prompts[1])
    });
  });

  it("tracks prompt delete confirmation state", () => {
    usePromptSettingsStore.getState().setDeletePromptConfirmation(prompts[1]);
    expect(usePromptSettingsStore.getState().deletePromptConfirmation).toEqual(prompts[1]);

    usePromptSettingsStore.getState().setDeletePromptConfirmation(null);
    expect(usePromptSettingsStore.getState().deletePromptConfirmation).toBeNull();
  });
});
