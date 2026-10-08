"use client";

import { useEffect, useRef, useState } from "react";
import { useComposerSessionStore, type ComposerSessionKey } from "@/components/app-shell/composerSessionStore";
import { useRunLifecycleStore } from "@/components/app-shell/runLifecycleStore";
import { chatSummaryFromApi, shellFetch } from "@/components/app-shell/shellApi";
import { responseErrorMessage } from "@/components/app-shell/shellFormatting";
import { visibleMessagePath } from "@/components/app-shell/threadPath";
import { selectThreadSnapshot, useThreadStore } from "@/components/app-shell/threadStore";
import type { Notice } from "@/components/app-shell/types";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import {
  ANSWER_REVIEW_AUTO_DEFAULT,
  answerReviewRefusalCopy,
  decodeAnswerReviewStartResponse,
  type AnswerReviewAutoConfig
} from "@/lib/contracts/answerReviews";
import { decodeChatSummaryResponse, type WorkspaceChatSummary } from "@/lib/contracts/chats";
import {
  answerReviewAutoStateV2,
  answerReviewGroupProgressV2,
  groupAnswerReviewsV2,
  type AnswerReviewAutoStateV2,
  type AnswerReviewCatalogModelV2
} from "./answerReviewModel";

/** How often a page that shows a running automatic session reads its chat again. */
export const ANSWER_REVIEW_FOLLOW_MS = 1_500;

type RefreshActiveChat = (
  chatId: string | null,
  options?: { forceDetail?: boolean; preserveControls?: boolean; resumeRuns?: boolean }
) => Promise<unknown>;

/** A saved chat (not a blank one waiting for its first send) keeps its review on the server. */
function savedChat(chat: WorkspaceChatSummary | null): WorkspaceChatSummary | null {
  return chat && !chat.pendingPersonalDraft && !chat.pendingProjectDraft ? chat : null;
}

/**
 * The chat's automatic answer review as the composer and header show it: a
 * saved chat's own choice (off until chosen, with the default reviewers
 * offered), or a blank chat's choice before its first send (the Settings
 * default until changed). Saving changes the saved chat on the server, or
 * the blank chat's composer session; the first send stores it with the chat.
 */
export function useAnswerReviewAutoV2(input: Readonly<{
  activeChat: WorkspaceChatSummary | null;
  agentEnabled: boolean;
  assistantChat: boolean;
  authorModel: AnswerReviewCatalogModelV2 | undefined;
  /** Personal Settings default; a Project chat starts off with no reviewers. */
  defaults: AnswerReviewAutoConfig;
  draftConfig: AnswerReviewAutoConfig | null | undefined;
  knowledgeEnabled: boolean;
  models: readonly AnswerReviewCatalogModelV2[];
  projectContext: boolean;
  refreshProjectWorkspace?(): Promise<unknown>;
  sessionKey: ComposerSessionKey;
}>): Readonly<{
  forSend(): AnswerReviewAutoConfig | null;
  save(config: AnswerReviewAutoConfig): Promise<string | null>;
  saving: boolean;
  state: AnswerReviewAutoStateV2;
}> {
  const chat = savedChat(input.activeChat);
  const defaults = input.projectContext ? ANSWER_REVIEW_AUTO_DEFAULT : input.defaults;
  const config = chat
    ? chat.answerReview ?? { ...defaults, enabled: false }
    : input.draftConfig ?? defaults;
  const state = answerReviewAutoStateV2({ ...input, config });
  const [saving, setSaving] = useState(false);
  const latest = useRef(state);
  useEffect(() => { latest.current = state; });
  async function save(next: AnswerReviewAutoConfig): Promise<string | null> {
    if (!chat) {
      useComposerSessionStore.getState().updateSession(input.sessionKey, { answerReview: next });
      return null;
    }
    setSaving(true);
    try {
      const response = await shellFetch(`/api/chats/${encodeURIComponent(chat.id)}`, {
        body: JSON.stringify({ answerReview: next }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      });
      if (!response.ok) return await responseErrorMessage(response, "answer_review_save_failed");
      const saved = decodeChatSummaryResponse(await response.json().catch(() => null));
      if (!saved || saved.id !== chat.id) return "The review setting could not be saved. Try again.";
      useWorkspaceStore.getState().upsertChat(chatSummaryFromApi(saved));
      if (chat.projectId) void input.refreshProjectWorkspace?.();
      return null;
    } catch {
      return "The review setting could not be saved. Check your connection and try again.";
    } finally {
      setSaving(false);
    }
  }
  return { forSend: () => latest.current.send, save, saving, state };
}

/**
 * Follows the open chat's automatic answer review: while its latest group's
 * session runs and no run of the chat is being watched, the chat is read
 * again every `ANSWER_REVIEW_FOLLOW_MS`, so each step the server starts
 * shows live (and its Stop works) as the chat's run. A session this page saw
 * running announces its end once, like an answer (`notifyAnswerReady`),
 * unless the user stopped it or moved on.
 */
export function useAnswerReviewFollowV2(input: Readonly<{
  chatId: string | null;
  notifyAnswerReady(): Promise<void>;
  refreshActiveChat: RefreshActiveChat;
}>): void {
  const { chatId } = input;
  const notify = useRef(input.notifyAnswerReady);
  const refresh = useRef(input.refreshActiveChat);
  useEffect(() => {
    notify.current = input.notifyAnswerReady;
    refresh.current = input.refreshActiveChat;
  });
  useEffect(() => {
    if (!chatId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const seenRunning = new Set<string>();
    const announced = new Set<string>();
    const check = () => {
      if (disposed) return;
      const thread = selectThreadSnapshot(useThreadStore.getState(), chatId);
      const path = visibleMessagePath(thread.messages, thread.activeLeafId);
      const items = groupAnswerReviewsV2(path);
      let follow = false;
      items.forEach((item, index) => {
        if (item.kind !== "review" || item.group.session.mode !== "auto") return;
        const progress = answerReviewGroupProgressV2(item.group);
        const id = item.group.session.id;
        if (progress.state === "running") {
          seenRunning.add(id);
          if (index === items.length - 1) follow = true;
        } else if (seenRunning.has(id) && !announced.has(id)) {
          announced.add(id);
          if (progress.stopReason !== "user_stopped" && progress.stopReason !== "superseded") void notify.current();
        }
      });
      const watched = Boolean(useRunLifecycleStore.getState().activeStreams[chatId]);
      if (!follow || watched || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        if (disposed) return;
        void refresh.current(chatId, { forceDetail: true, preserveControls: true, resumeRuns: true })
          .catch(() => null).finally(check);
      }, ANSWER_REVIEW_FOLLOW_MS);
    };
    check();
    const unsubscribeThread = useThreadStore.subscribe(check);
    const unsubscribeRuns = useRunLifecycleStore.subscribe(check);
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      unsubscribeThread();
      unsubscribeRuns();
    };
  }, [chatId]);
}

/** Stops an automatic session (its running step too), says why when it could not, and reads the chat again. */
export async function stopAnswerReviewSessionV2(input: Readonly<{
  chatId: string;
  refreshActiveChat: RefreshActiveChat;
  sessionId: string;
  setNotice(notice: Notice): void;
}>): Promise<void> {
  let failure: string | null = null;
  try {
    const response = await shellFetch(`/api/answer-reviews/${encodeURIComponent(input.sessionId)}/stop`, { method: "POST" });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok || !decodeAnswerReviewStartResponse(body)) {
      const code = typeof body === "object" && body !== null && typeof (body as Record<string, unknown>).error === "string"
        ? (body as Record<string, string>).error : null;
      failure = answerReviewRefusalCopy(code) ?? "The review could not be stopped. Try again.";
    }
  } catch {
    failure = "The review could not be stopped. Check your connection and try again.";
  }
  if (failure) input.setNotice({ chatId: input.chatId, kind: "error", text: failure });
  await input.refreshActiveChat(input.chatId, { forceDetail: true, preserveControls: true, resumeRuns: false }).catch(() => null);
}
