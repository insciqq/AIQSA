import { fetchAssistantDetail } from "@/components/assistants/assistantsApi";
import type { AssistantArchiveOutcome } from "@/components/app-shell/assistantGalleryActions";
import { useChatAssistantProjectionStore } from "@/components/app-shell/chatAssistantProjectionStore";
import {
  composerAssistantChangedRows,
  composerAssistantDefinitionFromDetail,
  composerAssistantFromDefinition,
  composerAssistantOverride,
  type ComposerAssistantContext,
  type ComposerAssistantDefaults,
  type ComposerAssistantDefinition
} from "@/components/app-shell/composerAssistantState";
import {
  boundComposerAssistant,
  useComposerControlStore
} from "@/components/app-shell/composerControlStore";
import { isRecord } from "@/components/app-shell/shellValues";
import { shellFetch } from "@/components/app-shell/shellApi";
import type { Notice } from "@/components/app-shell/types";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import {
  decodeAssistantDetailResponse,
  type AssistantDetail,
  type AssistantIdentity,
  type AssistantRowKey
} from "@/lib/contracts/assistants";
import type {
  ChatAssistantOverridesPatch,
  ChatAssistantOverrideValues,
  UpdateChatRequestWire
} from "@/lib/contracts/chats";
import {
  EMPTY_KNOWLEDGE_SELECTION,
  explicitKnowledgeSelection,
  KNOWLEDGE_SELECTION_VERSION
} from "@/lib/contracts/knowledge";

/** Where the active composer resolves an Assistant it chooses before a chat exists. */
export type ChatAssistantChooseScope = {
  context: ComposerAssistantContext;
  defaults: ComposerAssistantDefaults;
  /** Returns a blank composer to the scope's values without an Assistant. */
  restoreDefaults(): void;
};

export type ChatAssistantActionsInput = {
  /** Null while the scope's catalog is not loaded. */
  chooseScope(): ChatAssistantChooseScope | null;
  /** Re-reads the chat and applies its projection while the chat is open and `isCurrent` holds. */
  refreshChatAssistant(chatId: string, isCurrent: () => boolean): Promise<boolean>;
  setNotice(notice: Notice): void;
  /** Removes the shell notice when it is still this one; other notices stay. */
  clearNotice?(notice: Notice): void;
  /** Coalesces quick successive row changes (a typed temperature) into one chat update. */
  syncDelayMs?: number;
};

export type ChatAssistantAdoptResult =
  | { data: AssistantDetail; ok: true }
  | { code: string; message: string; ok: false };

const ASSISTANT_UPDATE_COPY: Readonly<Record<string, string>> = {
  assistant_not_available: "This Assistant isn't available to you.",
  assistant_overrides_invalid: "This setting can't be used in this chat.",
  assistant_overrides_not_allowed: "The Assistant fixes this setting for every chat."
};

const RESTORE_BUSY_COPY = "Wait for the current Assistant change to finish, then try again.";

/**
 * Reads an Assistant to start a new chat with it: the detail when the viewer
 * can use it now, otherwise whether it could not be used or not be read.
 */
async function startableAssistant(
  assistantId: string
): Promise<{ detail: AssistantDetail; ok: true } | { ok: false; reason: "unavailable" | "unloaded" }> {
  const detail = await fetchAssistantDetail(assistantId);
  if (!detail.ok) return { ok: false, reason: "unloaded" };
  return detail.data.availability.ok && !detail.data.archived
    ? { detail: detail.data, ok: true }
    : { ok: false, reason: "unavailable" };
}

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    return isRecord(body) && typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

async function chatUpdateFailure(response: Response): Promise<string> {
  const code = await errorCode(response);
  if (code && ASSISTANT_UPDATE_COPY[code]) return ASSISTANT_UPDATE_COPY[code];
  if (response.status === 409) return "Wait for the current answer to finish, then try again.";
  if (response.status === 404) return "This chat is no longer available.";
  return "The chat could not be updated. Try again.";
}

/**
 * Carries the chat's rows into its Assistant definition (owner only). The
 * server copies the rows changed for this chat without changing policies.
 */
export async function adoptChatSetup(
  assistantId: string,
  input: Readonly<{ chatId: string; expectedVersion: number }>
): Promise<ChatAssistantAdoptResult> {
  let response: Response;
  try {
    response = await shellFetch(`/api/me/assistants/${encodeURIComponent(assistantId)}/adopt-chat-setup`, {
      body: JSON.stringify({ chatId: input.chatId, expectedVersion: input.expectedVersion }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  } catch {
    return { code: "network_unavailable", message: "The Assistant could not be saved. Check the connection and try again.", ok: false };
  }
  if (!response.ok) {
    const code = await errorCode(response) ?? "assistant_request_failed";
    return {
      code,
      message: code === "assistant_version_conflict"
        ? "This Assistant changed in another session. Try again."
        : "The chat setup could not be saved to the Assistant.",
      ok: false
    };
  }
  let decoded: AssistantDetail | null = null;
  try {
    decoded = decodeAssistantDetailResponse(await response.json())?.assistant ?? null;
  } catch {
    decoded = null;
  }
  return decoded
    ? { data: decoded, ok: true }
    : { code: "assistant_response_invalid", message: "The Assistant response could not be read. Refresh and try again.", ok: false };
}

/**
 * The composer's Assistant actions. In a chat that does not exist yet they
 * change composer state, which the first message carries; in an existing
 * chat they are chat updates followed by a read of the chat's projection.
 * Results are keyed by chat and ignored once a newer change or another chat
 * took over.
 */
export function createChatAssistantActions(input: ChatAssistantActionsInput) {
  const syncDelayMs = input.syncDelayMs ?? 400;
  const queued = new Map<string, { patch: ChatAssistantOverridesPatch; timer: ReturnType<typeof setTimeout> }>();
  const generations = new Map<string, number>();
  /** Actions in flight per chat that change its Assistant or values; each resolves to whether it succeeded. */
  const inFlight = new Map<string, Set<Promise<boolean>>>();
  /** Chats (a blank chat as "") with a Restore in flight. */
  const restoring = new Set<string>();
  /** The failure notice a chat's (a blank chat's "") last Restore wrote, until the chat's Assistant changes. */
  const restoreFailures = new Map<string, Notice>();

  function reportRestoreFailure(key: string, text: string) {
    const notice: Notice = { kind: "error", text };
    restoreFailures.set(key, notice);
    input.setNotice(notice);
  }

  /**
   * A way out that made the chat usable (a Restore, Continue without the
   * Assistant, another Assistant) clears the failure an earlier Restore of
   * the same chat wrote, if it is still shown.
   */
  function clearRestoreFailure(key: string) {
    const notice = restoreFailures.get(key);
    if (!notice) return;
    restoreFailures.delete(key);
    input.clearNotice?.(notice);
  }

  function existingChatId(): string | null {
    const workspace = useWorkspaceStore.getState();
    const chat = workspace.activeChatId
      ? workspace.chats.find((candidate) => candidate.id === workspace.activeChatId)
      : null;
    return chat && !chat.pendingPersonalDraft && !chat.pendingProjectDraft ? chat.id : null;
  }

  /**
   * The chat list shows a chat's Assistant as soon as its binding changes;
   * the next page read brings the server's projection.
   */
  function showInChatList(chatId: string, assistant: AssistantIdentity | null) {
    const workspace = useWorkspaceStore.getState();
    const row = workspace.navigationChats.find((candidate) => candidate.id === chatId);
    if (row) workspace.upsertNavigationChat({ ...row, assistant });
  }

  function nextGeneration(chatId: string): number {
    const generation = (generations.get(chatId) ?? 0) + 1;
    generations.set(chatId, generation);
    return generation;
  }

  /**
   * The one registration of an action that will change the Assistant or the
   * values of an existing chat: the chat counts as pending from the action's
   * first step (a detail read, a library call) to its last (the chat's
   * re-read), and runs of the chat wait for it (see `settle`). `succeeded`
   * reads the action's result; a thrown action counts as failed. Without a
   * chat (a blank chat's composer state) the action runs untracked.
   */
  function track<T>(
    chatId: string | null,
    action: () => Promise<T>,
    succeeded: (result: T) => boolean = () => true
  ): Promise<T> {
    const run = action();
    if (!chatId) return run;
    const outcome = run.then(succeeded, () => false);
    const pending = inFlight.get(chatId) ?? new Set<Promise<boolean>>();
    pending.add(outcome);
    inFlight.set(chatId, pending);
    void outcome.then(() => {
      pending.delete(outcome);
      if (pending.size === 0 && inFlight.get(chatId) === pending) inFlight.delete(chatId);
    });
    return run;
  }

  /** `track` for an action on the open chat, when it is an existing chat. */
  function trackOpenChat<T>(action: () => Promise<T>, succeeded?: (result: T) => boolean): Promise<T> {
    return track(existingChatId(), action, succeeded);
  }

  /** Sends one chat update and re-reads the projection; returns the failure copy or null. */
  function updateChat(
    chatId: string,
    body: Pick<UpdateChatRequestWire, "assistantId" | "assistantOverrides">
  ): Promise<string | null> {
    return track(chatId, () => sendChatUpdate(chatId, body), (failure) => failure === null);
  }

  async function sendChatUpdate(
    chatId: string,
    body: Pick<UpdateChatRequestWire, "assistantId" | "assistantOverrides">
  ): Promise<string | null> {
    const generation = nextGeneration(chatId);
    const projections = useChatAssistantProjectionStore.getState();
    projections.beginUpdate(chatId);
    try {
      let failure: string | null = null;
      try {
        const response = await shellFetch(`/api/chats/${encodeURIComponent(chatId)}`, {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
          method: "PATCH"
        });
        if (!response.ok) failure = await chatUpdateFailure(response);
      } catch {
        failure = "The chat could not be updated. Check the connection and try again.";
      }
      // Success or not, the server's projection is what the composer shows.
      await input.refreshChatAssistant(chatId, () => generations.get(chatId) === generation);
      return failure;
    } finally {
      useChatAssistantProjectionStore.getState().finishUpdate(chatId);
    }
  }

  function dropQueued(chatId: string, rows?: readonly AssistantRowKey[]) {
    const entry = queued.get(chatId);
    if (!entry) return;
    if (rows) {
      for (const row of rows) delete entry.patch[row];
      if (Object.keys(entry.patch).length > 0) return;
    }
    clearTimeout(entry.timer);
    queued.delete(chatId);
  }

  async function flushQueued(chatId: string): Promise<void> {
    const entry = queued.get(chatId);
    if (!entry) return;
    clearTimeout(entry.timer);
    queued.delete(chatId);
    const failure = await updateChat(chatId, { assistantOverrides: entry.patch });
    if (failure) input.setNotice({ kind: "error", text: failure });
  }

  /**
   * Takes the rows the user just changed in an existing chat and queues them
   * as the chat's values. A blank chat keeps them in composer state for its
   * first message. Call it on every composer control change.
   */
  function syncChangedRows(): void {
    const state = useComposerControlStore.getState();
    if (!boundComposerAssistant(state)?.unsyncedRows.length) return;
    const rows = state.takeUnsyncedAssistantRows();
    const chatId = existingChatId();
    if (!chatId) return;
    const model = input.chooseScope()?.context.models.find((candidate) =>
      candidate.provider === state.selectedProvider && candidate.modelId === state.selectedModelId
    );
    const patch: ChatAssistantOverridesPatch = {};
    for (const row of rows) {
      const value = composerAssistantOverride(state, row, model);
      if (value) Object.assign(patch, { [row]: value });
    }
    if (Object.keys(patch).length === 0) return;
    nextGeneration(chatId);
    const entry = queued.get(chatId);
    if (entry) clearTimeout(entry.timer);
    const merged: ChatAssistantOverridesPatch = { ...entry?.patch };
    // A controls override belongs to the model it was set for; a
    // model change leaves earlier parameter changes behind.
    if ("model" in patch) delete merged.controls;
    queued.set(chatId, {
      patch: { ...merged, ...patch },
      timer: setTimeout(() => void flushQueued(chatId), syncDelayMs)
    });
  }

  /** A change of the chat's Assistant or of its values is queued or in flight. */
  function hasPendingUpdate(chatId: string): boolean {
    return queued.has(chatId) || (inFlight.get(chatId)?.size ?? 0) > 0;
  }

  /**
   * Resolves once no tracked action on the chat is queued or in flight,
   * flushing queued row changes first, so a run built afterwards carries the
   * chat's settled state. False when an action it waited for failed; that
   * action reports its own notice, and the run must not start.
   */
  async function settle(chatId: string): Promise<boolean> {
    let settled = true;
    for (;;) {
      if (queued.has(chatId)) void flushQueued(chatId);
      const pending = [...(inFlight.get(chatId) ?? [])];
      if (pending.length === 0) return settled;
      const outcomes = await Promise.all(pending);
      for (const outcome of pending) inFlight.get(chatId)?.delete(outcome);
      if (outcomes.includes(false)) settled = false;
    }
  }

  /**
   * Re-reads the chat's Assistant after the server refused a run because it
   * changed elsewhere (another tab), so the next send uses the current one.
   */
  function resync(chatId: string): Promise<boolean> {
    return track(chatId, () => input.refreshChatAssistant(chatId, () => existingChatId() === chatId));
  }

  /**
   * "Restore" in a chat whose Assistant its owner archived. `restore` is the
   * library's unarchive; a refusal or failure is reported here, in the chat
   * where the user asked. An existing chat stays pending until it re-read
   * its projection, which shows the restored Assistant or keeps the notice;
   * a blank chat chooses the Assistant again only once it is restored. A
   * repeated click while a restore of the same chat is in flight does
   * nothing. Resolves to whether the Assistant was restored.
   */
  async function restoreArchivedAssistant(
    chatId: string | null,
    restore: () => Promise<AssistantArchiveOutcome>,
    chooseRestored: () => void
  ): Promise<boolean> {
    const key = chatId ?? "";
    if (restoring.has(key)) return false;
    restoring.add(key);
    if (chatId) useChatAssistantProjectionStore.getState().beginUpdate(chatId);
    try {
      return await track(chatId, async () => {
        const outcome = await restore();
        if (!outcome.ok && outcome.reason === "failed") reportRestoreFailure(key, outcome.text);
        if (!outcome.ok && outcome.reason === "busy") reportRestoreFailure(key, RESTORE_BUSY_COPY);
        if (chatId) {
          // A refusal changed nothing; otherwise the server's projection is what the chat shows.
          if (outcome.ok || outcome.reason !== "busy") {
            await input.refreshChatAssistant(chatId, () => existingChatId() === chatId);
          }
        } else if (outcome.ok) {
          chooseRestored();
        }
        if (outcome.ok) clearRestoreFailure(key);
        return outcome.ok;
      }, (restored) => restored);
    } finally {
      restoring.delete(key);
      if (chatId) useChatAssistantProjectionStore.getState().finishUpdate(chatId);
    }
  }

  /** Chooses an Assistant definition; returns the failure copy or null. */
  function chooseDefinition(
    definition: ComposerAssistantDefinition,
    skill?: ComposerAssistantContext["skill"]
  ): Promise<string | null> {
    return trackOpenChat(() => chooseDefinitionNow(definition, skill), (failure) => failure === null);
  }

  async function chooseDefinitionNow(
    definition: ComposerAssistantDefinition,
    skill?: ComposerAssistantContext["skill"]
  ): Promise<string | null> {
    const chatId = existingChatId();
    if (chatId) {
      const current = useComposerControlStore.getState().assistant;
      if (current?.state === "bound" && current.id === definition.id) return null;
      dropQueued(chatId);
      const failure = await updateChat(chatId, { assistantId: definition.id });
      if (!failure) {
        showInChatList(chatId, { avatar: definition.avatar, name: definition.name });
        clearRestoreFailure(chatId);
      }
      return failure;
    }
    const scope = input.chooseScope();
    if (!scope) return "Models are still loading. Try again in a moment.";
    const applied = composerAssistantFromDefinition(
      definition,
      skill ? { ...scope.context, skill: (id) => skill(id) ?? scope.context.skill(id) } : scope.context,
      scope.defaults
    );
    if (!applied) return "This Assistant's model isn't available to you right now.";
    useComposerControlStore.getState().applyAssistantState(applied);
    clearRestoreFailure("");
    return null;
  }

  function chooseAssistant(detail: AssistantDetail): Promise<string | null> {
    return chooseDefinition(
      composerAssistantDefinitionFromDetail(detail),
      (skillId) => detail.skills?.find((skill) => skill.id === skillId) ?? null
    );
  }

  /** "Remove for this chat" and "Continue without the Assistant". */
  async function removeAssistant(): Promise<void> {
    const chatId = existingChatId();
    if (chatId) {
      if (!useComposerControlStore.getState().assistant) return;
      dropQueued(chatId);
      const failure = await updateChat(chatId, { assistantId: null });
      if (failure) {
        input.setNotice({ kind: "error", text: failure });
      } else {
        showInChatList(chatId, null);
        clearRestoreFailure(chatId);
      }
      return;
    }
    const scope = input.chooseScope();
    if (scope) scope.restoreDefaults();
    else useComposerControlStore.getState().clearAssistant();
    clearRestoreFailure("");
  }

  /**
   * Starts the open blank chat with the personal default Assistant through
   * the same path as choosing it; true once it is the composer's Assistant.
   * A default that can't be used is reported and never replaced.
   */
  async function chooseDefaultAssistant(assistantId: string, isCurrent: () => boolean): Promise<boolean> {
    const startable = await startableAssistant(assistantId);
    if (!isCurrent()) return false;
    if (!startable.ok) {
      input.setNotice({
        kind: "error",
        text: startable.reason === "unavailable"
          ? "Your default Assistant isn't available to you right now. This chat starts without it."
          : "Your default Assistant could not be loaded. This chat starts without it."
      });
      return false;
    }
    const failure = await chooseAssistant(startable.detail);
    if (failure) input.setNotice({ kind: "error", text: failure });
    return failure === null;
  }

  /**
   * Starts the open blank chat with the Assistant of an entry link (null for
   * a malformed id) through the same path as choosing it, while `isCurrent`
   * holds. Missing, foreign, archived, unusable and unreadable Assistants
   * alike leave the blank chat without an Assistant and report nothing, so
   * the caller shows one neutral notice.
   */
  async function chooseLinkedAssistant(
    assistantId: string | null,
    isCurrent: () => boolean
  ): Promise<"chosen" | "superseded" | "unavailable"> {
    const startable = assistantId === null ? null : await startableAssistant(assistantId);
    if (!isCurrent() || existingChatId() !== null) return "superseded";
    const failure = startable?.ok ? await chooseAssistant(startable.detail) : "unavailable";
    if (failure === null) return "chosen";
    if (useComposerControlStore.getState().assistant) await removeAssistant();
    return "unavailable";
  }

  async function resetRow(row: AssistantRowKey): Promise<void> {
    const chatId = existingChatId();
    const assistant = boundComposerAssistant(useComposerControlStore.getState());
    if (!assistant || assistant.rows[row].policy === "fixed") return;
    if (!chatId) {
      useComposerControlStore.getState().resetAssistantRow(row);
      return;
    }
    dropQueued(chatId, [row]);
    const failure = await updateChat(chatId, { assistantOverrides: { [row]: null } });
    if (failure) input.setNotice({ kind: "error", text: failure });
  }

  /**
   * Sets a row to a value for this chat through the composer's own setters;
   * false when the Assistant fixes the row or the value is not in the catalog.
   */
  function setRow<Key extends AssistantRowKey>(row: Key, value: ChatAssistantOverrideValues[Key]): boolean {
    const store = useComposerControlStore.getState();
    const assistant = boundComposerAssistant(store);
    if (assistant?.rows[row].policy === "fixed") return false;
    const scope = input.chooseScope();
    switch (row) {
      case "model": {
        const modelValue = value as ChatAssistantOverrideValues["model"];
        const model = scope?.context.models.find((candidate) => candidate.modelId === modelValue.modelId);
        if (!scope || !model) return false;
        store.applyModelSelection({
          controlDefaults: scope.context.controlDefaults(model),
          modelId: model.modelId,
          provider: model.provider,
          searchStrategyIds: model.searchStrategyIds
        });
        break;
      }
      case "controls": {
        const controls = value as ChatAssistantOverrideValues["controls"];
        if (controls.backgroundMode !== undefined) store.setBackgroundMode(controls.backgroundMode);
        if (controls.maxOutputTokens !== undefined) store.setMaxOutputTokens(String(controls.maxOutputTokens));
        if (controls.reasoningEffort !== undefined) store.setReasoningEffort(controls.reasoningEffort);
        if (controls.reasoningMode !== undefined) store.setReasoningMode(controls.reasoningMode);
        if (controls.streamMode !== undefined) store.setStreamMode(controls.streamMode);
        if (controls.temperature !== undefined) store.setTemperature(String(controls.temperature));
        break;
      }
      case "search": {
        const search = value as ChatAssistantOverrideValues["search"];
        if (search.mode === "off") store.setSelectedSearchPlan([], "all_selected");
        else store.setSelectedSearchPlan(search.optionIds, search.mode);
        break;
      }
      case "tools":
        store.setMcpSelection(value as ChatAssistantOverrideValues["tools"]);
        break;
      case "knowledge": {
        const knowledge = value as ChatAssistantOverrideValues["knowledge"];
        store.setSelectedKnowledgePlan(knowledge.mode === "explicit"
          ? explicitKnowledgeSelection({ baseIds: knowledge.baseIds, sourceIds: knowledge.sourceIds })
          : knowledge.mode === "all_my_knowledge"
            ? { baseIds: [], mode: "all_my_knowledge", sourceIds: [], version: KNOWLEDGE_SELECTION_VERSION }
            : EMPTY_KNOWLEDGE_SELECTION);
        break;
      }
      default:
        store.setSkillsMode((value as ChatAssistantOverrideValues["skills"]).mode);
    }
    return true;
  }

  /**
   * "Save chat setup to Assistant" (owner): the rows changed for this chat
   * become the Assistant's values, and the chat drops its now equal values.
   */
  function saveChatSetupToAssistant(): Promise<boolean> {
    // A refused adopt leaves the chat as it was; only its final chat update
    // (tracked on its own) can leave a run waiting on a failure.
    return trackOpenChat(saveChatSetupNow);
  }

  async function saveChatSetupNow(): Promise<boolean> {
    const chatId = existingChatId();
    const state = useComposerControlStore.getState();
    const assistant = boundComposerAssistant(state);
    const changed = composerAssistantChangedRows(state);
    if (!chatId || !assistant?.owned || changed.length === 0) return false;
    await flushQueued(chatId);
    const projections = useChatAssistantProjectionStore.getState();
    projections.beginUpdate(chatId);
    try {
      const detail = await fetchAssistantDetail(assistant.id);
      if (!detail.ok || detail.data.version === undefined) {
        input.setNotice({ kind: "error", text: detail.ok ? "The Assistant could not be read. Try again." : detail.message });
        return false;
      }
      const adopted = await adoptChatSetup(assistant.id, { chatId, expectedVersion: detail.data.version });
      if (!adopted.ok) {
        input.setNotice({ kind: "error", text: adopted.message });
        return false;
      }
      const failure = await updateChat(chatId, {
        assistantOverrides: Object.fromEntries(changed.map((row) => [row, null]))
      });
      input.setNotice(failure
        ? { kind: "error", text: failure }
        : { kind: "success", text: `Chat setup saved to ${adopted.data.content.name}.` });
      return failure === null;
    } finally {
      useChatAssistantProjectionStore.getState().finishUpdate(chatId);
    }
  }

  return {
    chooseAssistant,
    chooseDefaultAssistant,
    chooseDefinition,
    chooseLinkedAssistant,
    continueWithoutAssistant: removeAssistant,
    hasPendingUpdate,
    removeAssistant,
    resetRow,
    restoreArchivedAssistant,
    resync,
    saveChatSetupToAssistant,
    setRow,
    settle,
    syncChangedRows,
    track,
    trackOpenChat
  };
}

export type ChatAssistantActions = ReturnType<typeof createChatAssistantActions>;
