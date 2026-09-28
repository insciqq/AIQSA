import { fetchAssistantDetail, fetchAssistantList } from "@/components/assistants/assistantsApi";
import {
  useAssistantLibraryStore,
  type AssistantLibrarySnapshot
} from "@/components/app-shell/assistantLibraryStore";
import { loadUserMcpServers } from "@/components/app-shell/mcpSettingsApi";
import type { Catalog } from "@/components/app-shell/types";
import type { AssistantDetail, AssistantRunControlField } from "@/lib/contracts/assistants";
import type { SkillSummary } from "@/lib/contracts/skills";

export type AssistantLibraryControllerInput = {
  /** A new chat; `temporary` asks for a Temporary chat where the account allows one. */
  activateBlankWorkspace(options?: { temporary?: boolean }): void;
  /**
   * Chooses the Assistant for the open composer: composer state in a chat
   * that does not exist yet, a chat update in an existing chat. Resolves to
   * the failure copy, or null once chosen.
   */
  chooseAssistant(detail: AssistantDetail): Promise<string | null>;
  catalog: Catalog | null;
  catalogError: string | null;
  knowledgeBases: { available: boolean; id: string; name: string }[];
  knowledgeSources: { available: boolean; id: string; name: string }[];
  knowledgeDataError: string | null;
  knowledgeDataState: "error" | "loading" | "ready";
  openMcpSettings(): void;
  retryCatalog(): void;
  retryKnowledge(): void;
  setShellNotice(notice: { kind: "error"; text: string }): void;
  skills: SkillSummary[];
};

const knownErrorText: Readonly<Record<string, string>> = {
  assistant_already_listed: "This assistant is already listed for everyone.",
  assistant_archived: "This assistant is archived. Restore it before saving changes.",
  assistant_avatar_invalid: "The avatar could not be saved. Generate another and retry.",
  assistant_category_invalid: "Choose one of the listed categories.",
  assistant_description_invalid: "Shorten the description to 400 characters.",
  assistant_listing_request_conflict: "The listing request changed in another session. Reopen Sharing and try again.",
  assistant_listing_request_not_needed: "Administrators list for everyone directly.",
  assistant_mcp_servers_invalid: "The MCP tool selection is invalid.",
  assistant_model_invalid: "Choose a model from your catalog.",
  assistant_model_not_available: "Choose a model from your catalog.",
  assistant_name_invalid: "Enter a name of up to 80 characters.",
  assistant_not_available: "This assistant is no longer available.",
  assistant_row_controls_require_fixed_model: "Fix the model before fixing its parameters.",
  assistant_row_fixed_requires_value: "Choose a value to fix, or make this row Adjustable.",
  assistant_run_controls_invalid: "The run controls are outside the model's supported range.",
  assistant_search_option_not_available: "One selected Search source is not available to you.",
  assistant_search_plan_invalid: "The Search selection is invalid.",
  assistant_skill_audience_mismatch: "Share every included Skill with this audience first, then save again.",
  assistant_skills_invalid: "The Skill selection is invalid.",
  skills_count_exceeded: "Choose up to 32 Always and 64 On demand Skills. Change delivery or remove a Skill before saving.",
  assistant_skills_not_available: "One selected Skill is no longer available to you.",
  assistant_knowledge_bases_invalid: "The Knowledge selection is invalid.",
  assistant_starter_prompts_invalid: "Keep up to 6 starters of up to 200 characters.",
  assistant_system_prompt_invalid: "Shorten the system prompt.",
  assistant_tools_not_available: "One selected MCP server is not available to you.",
  assistant_version_conflict:
    "This assistant changed in another session. Reload Assistants and reapply your edit."
};

export function assistantErrorText(code: string, message: string): string {
  return knownErrorText[code] ?? message;
}

export const runControlLabels: Readonly<Record<AssistantRunControlField, string>> = {
  backgroundMode: "Background",
  maxOutputTokens: "Max answer length",
  reasoningEffort: "Reasoning effort",
  reasoningMode: "Reasoning mode",
  streamMode: "Stream",
  temperature: "Temperature"
};

export function modelControlsFor(catalog: Catalog | null, modelId: string | null) {
  if (!modelId || !catalog) return null;
  return catalog.models.find((model) => model.modelId === modelId)?.parameterControls ?? null;
}

export function draftBaseline(draft: unknown): string {
  return JSON.stringify(draft);
}

export function editorDirty(snapshot: Pick<AssistantLibrarySnapshot, "editor">): boolean {
  const editor = snapshot.editor;
  return editor !== null && draftBaseline(editor.draft) !== editor.baseline;
}

export function sharingDirty(snapshot: Pick<AssistantLibrarySnapshot, "sharing">): boolean {
  const sharing = snapshot.sharing;
  return sharing !== null && sharing.state === "ready" && draftBaseline(sharing.draft) !== sharing.baseline;
}

/** Everything a Studio exit closes along with the Assistants surface. */
export const closedAssistantSurfaces: Partial<AssistantLibrarySnapshot> = {
  deletion: null,
  detail: null,
  editor: null,
  newAssistantOpen: false,
  sharing: null,
  task: "list"
};

/**
 * Shared state machinery of the Assistant library: one busy list mutation at
 * a time, the list and MCP option refreshes, and choosing an Assistant for a
 * chat. Gallery, editor and Sharing actions build on it.
 */
export function createAssistantLibraryCore(input: AssistantLibraryControllerInput) {
  const store = () => useAssistantLibraryStore.getState();

  function beginBusyOperation(): number | null {
    const snapshot = store();
    if (snapshot.busy || snapshot.editor?.saving) {
      return null;
    }
    const requestId = snapshot.busyRequestId + 1;
    snapshot.patch({ busy: true, busyRequestId: requestId });
    return requestId;
  }

  function ownsBusyOperation(requestId: number): boolean {
    const snapshot = store();
    return snapshot.busy && snapshot.busyRequestId === requestId;
  }

  function finishBusyOperation(
    requestId: number,
    update: Partial<AssistantLibrarySnapshot> = {}
  ): boolean {
    const snapshot = store();
    if (!snapshot.busy || snapshot.busyRequestId !== requestId) {
      return false;
    }
    snapshot.patch({ ...update, busy: false });
    return true;
  }

  async function refreshList() {
    const snapshot = store();
    const requestId = snapshot.listRequestId + 1;
    snapshot.patch({
      dataError: null,
      dataState: snapshot.data ? "ready" : "loading",
      listRequestId: requestId
    });
    const result = await fetchAssistantList();
    if (store().listRequestId !== requestId) {
      return;
    }
    if (!result.ok) {
      const current = store();
      if (current.data) {
        current.patch({ notice: { kind: "error", text: result.message } });
      } else {
        current.patch({ dataError: result.message, dataState: "error" });
      }
      return;
    }
    store().patch({ data: result.data, dataError: null, dataState: "ready" });
  }

  /**
   * The list for a surface that needs it before anyone loaded it (the blank
   * chat's strip, the picker, the default Assistant setting): one shared
   * load. It reads the store, not a render's snapshot, so a repeated effect
   * (React StrictMode replays them) joins the load in flight. A list that
   * failed to load is requested again; a loaded one is kept (refreshList
   * reloads it).
   */
  function ensureList() {
    const snapshot = store();
    if (snapshot.data || (snapshot.dataState === "loading" && snapshot.listRequestId > 0)) return;
    void refreshList();
  }

  async function refreshMcpOptions() {
    const snapshot = store();
    const requestId = snapshot.mcpOptionsRequestId + 1;
    // A previous successful response is not proof that the dependency remains
    // runnable. Clear it while revalidating so save fails closed.
    snapshot.patch({ mcpOptions: [], mcpOptionsRequestId: requestId });
    try {
      const servers = await loadUserMcpServers();
      const current = store();
      if (!current.open || current.mcpOptionsRequestId !== requestId) return;
      current.patch({
        mcpOptions: servers
          .map((server) => ({
            enabled: server.enabled,
            id: server.id,
            name: server.name,
            readiness: server.readiness
          }))
          .sort((left, right) => left.name.localeCompare(right.name))
      });
    } catch {
      // The request-start reset is the safe failure state. A later refresh may
      // repopulate it, but stale runnable choices are never retained.
    }
  }

  function openLibrary() {
    const snapshot = store();
    if (snapshot.busy || snapshot.editor?.saving) return;
    store().patch({ ...closedAssistantSurfaces, notice: null, open: true });
    void refreshList();
    void refreshMcpOptions();
  }

  function closeLibrary() {
    const snapshot = store();
    if (snapshot.busy || snapshot.editor?.saving) return;
    store().patch({
      ...closedAssistantSurfaces,
      mcpOptions: [],
      mcpOptionsRequestId: snapshot.mcpOptionsRequestId + 1,
      notice: null,
      open: false
    });
  }

  function reportFailure(requestId: number, text: string) {
    const notice = { kind: "error" as const, text };
    const libraryOpen = store().open;
    finishBusyOperation(requestId, libraryOpen ? { notice } : {});
    if (!libraryOpen) input.setShellNotice(notice);
  }

  /**
   * Chooses the currently authorized definition for the open composer: a
   * composer choice until a new chat's first message, a chat update in an
   * existing chat. It never creates a chat; from Studio it also navigates to
   * the blank workspace first. Unsaved Studio drafts refuse it.
   */
  async function useAssistant(assistantId: string, options: { navigate: boolean; temporary?: boolean }) {
    const snapshot = store();
    if (editorDirty(snapshot) || sharingDirty(snapshot)) {
      return false;
    }
    const requestId = beginBusyOperation();
    if (requestId === null) return false;
    const result = await fetchAssistantDetail(assistantId);
    if (!ownsBusyOperation(requestId)) return false;
    if (!result.ok) {
      reportFailure(requestId, result.message);
      return false;
    }
    const detail = result.data;
    if (!detail.availability.ok || detail.archived) {
      reportFailure(requestId, "This assistant needs access you do not currently have.");
      return false;
    }
    if (options.navigate) {
      if (options.temporary) input.activateBlankWorkspace({ temporary: true });
      else input.activateBlankWorkspace();
    }
    const failure = await input.chooseAssistant(detail);
    if (!ownsBusyOperation(requestId)) return false;
    if (failure) {
      reportFailure(requestId, failure);
      return false;
    }
    const currentMcpRequestId = store().mcpOptionsRequestId;
    finishBusyOperation(requestId, {
      ...closedAssistantSurfaces,
      mcpOptions: [],
      mcpOptionsRequestId: currentMcpRequestId + 1,
      notice: null,
      open: false
    });
    return true;
  }

  return {
    beginBusyOperation,
    closeLibrary,
    ensureList,
    finishBusyOperation,
    openLibrary,
    ownsBusyOperation,
    refreshList,
    refreshMcpOptions,
    store,
    useAssistant
  };
}

export type AssistantLibraryCore = ReturnType<typeof createAssistantLibraryCore>;
