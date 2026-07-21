import { useComposerControlStore } from "@/components/app-shell/composerControlStore";
import {
  type PromptEditorDraft,
  usePromptSettingsStore
} from "@/components/app-shell/promptSettingsStore";
import { errorMessage, responseErrorMessage } from "@/components/app-shell/shellFormatting";
import type { Catalog, Notice, PromptPreset } from "@/components/app-shell/types";
import { useCallback, useRef } from "react";

type PromptSettingsActionInput = {
  catalog: Catalog | null;
  currentPrompt: PromptPreset | null;
  getCatalog(): Catalog | null;
  persistUserDefaults(
    update: Partial<Catalog["defaults"]>,
    options?: { noticeScope?: "settings" }
  ): Promise<boolean>;
  setCatalog(update: (current: Catalog | null) => Catalog | null): void;
  setNotice(notice: Notice): void;
};

export type PromptSettingsActions = {
  cancelDeletePrompt(): void;
  closeSettings(): void;
  confirmDeletePrompt(): void;
  createSettingsPrompt(): Promise<void>;
  deleteSettingsPrompt(prompt: PromptPreset): Promise<void>;
  duplicateSettingsPrompt(prompt: PromptPreset): Promise<void>;
  editSettingsPrompt(prompt: PromptPreset): void;
  newSettingsPrompt(): void;
  openSettings(promptId?: string | null): void;
  selectPrompt(promptId: string): PromptPreset | null;
  setDefaultPromptPreset(promptId: string): Promise<void>;
  setSettingsPromptEditor(draft: PromptEditorDraft): void;
  updateSettingsPrompt(): Promise<void>;
  usePromptForNextRun(promptId: string): void;
};

function sortPrompts(prompts: PromptPreset[]) {
  return [...prompts].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
}

export function usePromptSettingsActions({
  catalog,
  currentPrompt,
  getCatalog,
  persistUserDefaults,
  setCatalog,
  setNotice
}: PromptSettingsActionInput): PromptSettingsActions {
  const deletePromptConfirmationResolveRef = useRef<((confirmed: boolean) => void) | null>(null);

  function setSettingsNotice(notice: Omit<Notice, "scope">) {
    setNotice({
      ...notice,
      scope: "settings"
    });
  }

  function upsertPromptInCatalog(prompt: PromptPreset) {
    setCatalog((current) =>
      current
        ? {
            ...current,
            promptPresets: sortPrompts([
              ...current.promptPresets.filter((candidate) => candidate.id !== prompt.id),
              prompt
            ])
          }
        : current
    );
  }

  function selectedPromptId() {
    return useComposerControlStore.getState().selectedPromptId;
  }

  function applyPromptToComposer(prompt: PromptPreset | null) {
    useComposerControlStore.getState().applyPrompt(prompt);
  }

  const closeDeletePromptConfirmation = useCallback((confirmed = false) => {
    deletePromptConfirmationResolveRef.current?.(confirmed);
    deletePromptConfirmationResolveRef.current = null;
    usePromptSettingsStore.getState().setDeletePromptConfirmation(null);
  }, []);

  const requestDeletePromptConfirmation = useCallback((prompt: PromptPreset) => {
    deletePromptConfirmationResolveRef.current?.(false);
    usePromptSettingsStore.getState().setDeletePromptConfirmation(prompt);

    return new Promise<boolean>((resolve) => {
      deletePromptConfirmationResolveRef.current = resolve;
    });
  }, []);

  function closeSettings() {
    usePromptSettingsStore.getState().closeSettings();
  }

  function openSettings(promptId = selectedPromptId()) {
    const prompt =
      catalog?.promptPresets.find((candidate) => candidate.id === promptId) ??
      currentPrompt ??
      catalog?.promptPresets[0] ??
      null;
    usePromptSettingsStore.getState().openSettings(prompt);
  }

  function newSettingsPrompt() {
    usePromptSettingsStore.getState().newSettingsPrompt();
  }

  function editSettingsPrompt(prompt: PromptPreset) {
    usePromptSettingsStore.getState().editSettingsPrompt(prompt);
  }

  function setSettingsPromptEditor(draft: PromptEditorDraft) {
    usePromptSettingsStore.getState().setSettingsPromptEditor(draft);
  }

  function selectPrompt(promptId: string): PromptPreset | null {
    const prompt = catalog?.promptPresets.find((candidate) => candidate.id === promptId) ?? null;
    if (!prompt) {
      return null;
    }

    applyPromptToComposer(prompt);

    return prompt;
  }

  function usePromptForNextRun(promptId: string) {
    const prompt = selectPrompt(promptId);
    if (!prompt) {
      return;
    }

    setSettingsNotice({
      kind: "success",
      text: `Prompt selected: ${prompt.name}`
    });
  }

  async function createSettingsPrompt() {
    const { promptSaving, settingsPromptEditor } = usePromptSettingsStore.getState();
    const name = settingsPromptEditor.name.trim();
    if (!name || !settingsPromptEditor.systemPrompt.trim() || promptSaving) {
      return;
    }

    usePromptSettingsStore.getState().setPromptSaving(true);
    try {
      const response = await fetch("/api/prompts", {
        body: JSON.stringify({
          developerPrompt: settingsPromptEditor.developerPrompt,
          name,
          systemPrompt: settingsPromptEditor.systemPrompt
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      if (!response.ok) {
        throw new Error(await responseErrorMessage(response, `prompt_create_failed_${response.status}`));
      }

      const body = (await response.json()) as { prompt: PromptPreset };
      upsertPromptInCatalog(body.prompt);
      usePromptSettingsStore.getState().setSettingsPromptFromPreset(body.prompt);
      setSettingsNotice({
        kind: "success",
        text: `Prompt saved: ${body.prompt.name}`
      });
    } catch (error) {
      setSettingsNotice({
        kind: "error",
        text: errorMessage(error)
      });
    } finally {
      usePromptSettingsStore.getState().setPromptSaving(false);
    }
  }

  async function updateSettingsPrompt() {
    const { promptSaving, settingsPromptEditor } = usePromptSettingsStore.getState();
    if (
      !settingsPromptEditor.id ||
      !settingsPromptEditor.name.trim() ||
      !settingsPromptEditor.systemPrompt.trim() ||
      promptSaving
    ) {
      return;
    }

    usePromptSettingsStore.getState().setPromptSaving(true);
    try {
      const response = await fetch(`/api/prompts/${settingsPromptEditor.id}`, {
        body: JSON.stringify({
          developerPrompt: settingsPromptEditor.developerPrompt,
          name: settingsPromptEditor.name,
          systemPrompt: settingsPromptEditor.systemPrompt
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "PATCH"
      });

      if (!response.ok) {
        throw new Error(await responseErrorMessage(response, `prompt_update_failed_${response.status}`));
      }

      const body = (await response.json()) as { prompt: PromptPreset };
      upsertPromptInCatalog(body.prompt);
      usePromptSettingsStore.getState().setSettingsPromptFromPreset(body.prompt);
      if (selectedPromptId() === body.prompt.id) {
        applyPromptToComposer(body.prompt);
      }
      setSettingsNotice({
        kind: "success",
        text: `Prompt updated: ${body.prompt.name}`
      });
    } catch (error) {
      setSettingsNotice({
        kind: "error",
        text: errorMessage(error)
      });
    } finally {
      usePromptSettingsStore.getState().setPromptSaving(false);
    }
  }

  async function duplicateSettingsPrompt(prompt: PromptPreset) {
    if (usePromptSettingsStore.getState().promptSaving) {
      return;
    }

    usePromptSettingsStore.getState().setPromptSaving(true);
    try {
      const response = await fetch("/api/prompts", {
        body: JSON.stringify({
          developerPrompt: prompt.developerPrompt ?? "",
          name: `${prompt.name} copy`,
          systemPrompt: prompt.systemPrompt
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      if (!response.ok) {
        throw new Error(await responseErrorMessage(response, `prompt_duplicate_failed_${response.status}`));
      }

      const body = (await response.json()) as { prompt: PromptPreset };
      upsertPromptInCatalog(body.prompt);
      usePromptSettingsStore.getState().setSettingsPromptFromPreset(body.prompt);
      setSettingsNotice({
        kind: "success",
        text: `Prompt duplicated: ${body.prompt.name}`
      });
    } catch (error) {
      setSettingsNotice({
        kind: "error",
        text: errorMessage(error)
      });
    } finally {
      usePromptSettingsStore.getState().setPromptSaving(false);
    }
  }

  async function setDefaultPromptPreset(promptId: string) {
    const prompt = catalog?.promptPresets.find((candidate) => candidate.id === promptId);
    if (!prompt || usePromptSettingsStore.getState().promptSaving) {
      return;
    }

    usePromptSettingsStore.getState().setPromptSaving(true);
    try {
      const saved = await persistUserDefaults(
        {
          promptPresetId: prompt.id
        },
        {
          noticeScope: "settings"
        }
      );
      if (!saved || getCatalog()?.defaults.promptPresetId !== prompt.id) {
        return;
      }

      setSettingsNotice({
        kind: "success",
        text: `Default prompt: ${prompt.name}`
      });
    } catch (error) {
      setSettingsNotice({
        kind: "error",
        text: errorMessage(error)
      });
    } finally {
      usePromptSettingsStore.getState().setPromptSaving(false);
    }
  }

  async function deleteSettingsPrompt(prompt: PromptPreset) {
    if (prompt.id === catalog?.defaults.promptPresetId || usePromptSettingsStore.getState().promptSaving) {
      return;
    }

    if (!(await requestDeletePromptConfirmation(prompt))) {
      return;
    }

    usePromptSettingsStore.getState().setPromptSaving(true);
    try {
      const response = await fetch(`/api/prompts/${prompt.id}`, {
        method: "DELETE"
      });

      if (!response.ok) {
        throw new Error(await responseErrorMessage(response, `prompt_delete_failed_${response.status}`));
      }

      const deletedPromptId = prompt.id;
      const remainingPrompts = catalog?.promptPresets.filter((candidate) => candidate.id !== deletedPromptId) ?? [];
      const nextPrompt =
        remainingPrompts.find((candidate) => candidate.id === catalog?.defaults.promptPresetId) ??
        remainingPrompts[0] ??
        null;
      setCatalog((current) => {
        if (!current) {
          return current;
        }

        const nextDefaultPromptId =
          current.defaults.promptPresetId === deletedPromptId ? null : current.defaults.promptPresetId;

        return {
          ...current,
          defaults: {
            ...current.defaults,
            promptPresetId: nextDefaultPromptId
          },
          promptPresets: current.promptPresets.filter((candidate) => candidate.id !== deletedPromptId)
        };
      });

      if (selectedPromptId() === deletedPromptId) {
        applyPromptToComposer(nextPrompt);
      }

      if (usePromptSettingsStore.getState().settingsPromptEditor.id === deletedPromptId) {
        usePromptSettingsStore.getState().setSettingsPromptFromPreset(nextPrompt);
      }

      setSettingsNotice({
        kind: "success",
        text: "Prompt deleted"
      });
    } catch (error) {
      setSettingsNotice({
        kind: "error",
        text: errorMessage(error)
      });
    } finally {
      usePromptSettingsStore.getState().setPromptSaving(false);
    }
  }

  return {
    cancelDeletePrompt: () => closeDeletePromptConfirmation(false),
    closeSettings,
    confirmDeletePrompt: () => closeDeletePromptConfirmation(true),
    createSettingsPrompt,
    deleteSettingsPrompt,
    duplicateSettingsPrompt,
    editSettingsPrompt,
    newSettingsPrompt,
    openSettings,
    selectPrompt,
    setDefaultPromptPreset,
    setSettingsPromptEditor,
    updateSettingsPrompt,
    usePromptForNextRun
  };
}
