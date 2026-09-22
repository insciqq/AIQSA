import { decodeRunFollowupState, RUN_FOLLOWUP_MAX_CHARS } from "@/lib/contracts/runFollowups";
import { randomUUID } from "@/lib/browser/randomUUID";
import { chatIdFromComposerSessionKey, selectComposerSession, useComposerSessionStore } from "./composerSessionStore";
import { selectThreadSnapshot, useThreadStore } from "./threadStore";
import { shellFetch } from "./shellApi";

class FollowupSubmissionError extends Error {}

/** Capture the chat/run/draft before I/O. Navigation never retargets a submission. */
export async function submitRunFollowup(runId: string): Promise<void> {
  const store = useComposerSessionStore.getState();
  const key = store.activeSessionKey;
  const chatId = chatIdFromComposerSessionKey(key);
  const session = selectComposerSession(store, key);
  const text = session.draft.trim();
  if (!chatId || !text || session.followupSubmission?.inFlight || session.editingMessageId) return;
  const previous = session.followupSubmission;
  const retry = previous?.runId === runId && previous.text === text ? previous : null;
  const message = selectThreadSnapshot(useThreadStore.getState(), chatId).messages.find(entry => entry.runId === runId);
  const assistantMessageId = retry?.assistantMessageId ?? message?.id;
  if (!assistantMessageId) return;
  if (session.draft.length > RUN_FOLLOWUP_MAX_CHARS) {
    store.updateSession(key, { operationError: `Keep the follow-up under ${RUN_FOLLOWUP_MAX_CHARS.toLocaleString()} characters.` });
    return;
  }
  const submission = { assistantMessageId, runId, text, nonce: retry?.nonce ?? randomUUID(), inFlight: true };
  store.updateSession(key, { followupSubmission: submission, operationError: null });
  // updateSession may increment the general session revision; take the draft
  // fence after recording the pending request, before any asynchronous work.
  const draftRevision = selectComposerSession(useComposerSessionStore.getState(), key).revision;
  try {
    const response = await shellFetch(`/api/model-runs/${encodeURIComponent(runId)}/followups`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId, assistantMessageId, nonce: submission.nonce, text })
    });
    const body: unknown = await response.json().catch(() => null);
    const payload = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const accepted = response.ok ? decodeRunFollowupState({ available: true, entries: [payload.followup] })?.entries[0] : null;
    if (!accepted) {
      const error = payload.error;
      throw new FollowupSubmissionError(error === "followup_closed" ? "This answer has finished accepting follow-ups. Your text is still here."
        : error === "followup_context_full" ? "This follow-up exceeds the remaining context. Shorten it or send a new message after the answer."
        : error === "model_run_not_found" || response.status === 403 ? "You can no longer add a follow-up to this answer. Your text is still here."
        : "The follow-up could not be confirmed. Retry to check the same submission.");
    }
    useThreadStore.getState().updateMessages(chatId, messages => messages.map(entry => {
      if (entry.id !== assistantMessageId || entry.runId !== runId) return entry;
      const existing = entry.followups?.entries ?? [];
      // A streaming/polling update may already have observed delivery.
      const receipt = existing.find(item => item.id === accepted.id);
      const entries = [...existing.filter(item => item.id !== accepted.id), receipt && receipt.delivery !== "accepted" ? receipt : accepted]
        .sort((a, b) => a.ordinal - b.ordinal);
      return { ...entry, followups: { available: entry.followups?.available ?? entry.status === "streaming", entries } };
    }));
    const current = selectComposerSession(useComposerSessionStore.getState(), key);
    if (current.followupSubmission?.nonce === submission.nonce) {
      store.updateSession(key, { followupSubmission: null, operationError: null,
        ...(current.revision === draftRevision && current.draft === session.draft ? { draft: "" } : {}) });
    }
  } catch (error) {
    const current = selectComposerSession(useComposerSessionStore.getState(), key);
    if (current.followupSubmission?.nonce === submission.nonce) store.updateSession(key, {
      followupSubmission: { ...submission, inFlight: false },
      operationError: error instanceof FollowupSubmissionError ? error.message
        : "The follow-up could not be confirmed. Retry to check the same submission."
    });
  }
}
