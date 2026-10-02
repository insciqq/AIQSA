import {
  chatIdFromComposerSessionKey,
  projectIdFromComposerSessionKey,
  type ComposerSessionKey,
  selectComposerSession,
  useComposerSessionStore
} from "@/components/app-shell/composerSessionStore";
import {
  attachmentRetryAvailable,
  ATTACHMENT_POLL_TIMEOUT_ERROR_CODE,
  ATTACHMENT_UNAVAILABLE_ERROR_CODE
} from "@/components/app-shell/attachmentLifecycle";
import { shellFetch, shellReadJson } from "@/components/app-shell/shellApi";
import { errorMessage } from "@/components/app-shell/shellFormatting";
import { textFromThreadContent } from "@/components/app-shell/threadContent";
import { latestResumableRunId } from "@/components/app-shell/threadPath";
import type { ChatDetail, WorkspaceChatSummary, Notice } from "@/components/app-shell/types";
import {
  RESUME_POLL_BACKGROUND_DELAY_MS,
  RESUME_POLL_HORIZON_MS,
  RESUME_POLL_INITIAL_DELAY_MS,
  RESUME_POLL_MAX_DELAY_MS
} from "@/components/app-shell/powerAppShellData";
import { useRunLifecycleStore } from "@/components/app-shell/runLifecycleStore";
import { useRunSurfaceStore } from "@/components/app-shell/runSurfaceStore";
import { selectThreadSnapshot, useThreadStore } from "@/components/app-shell/threadStore";
import {
  decodeCancelModelRunResponse,
  decodeRunOutcomeResponse,
  type RunOutcome
} from "@/lib/contracts/runs";
import { decodeUploadAttachmentResponse, decodeUploadErrorResponse, type UploadedAttachmentWire } from "@/lib/contracts/uploads";
import type { Dispatch, SetStateAction } from "react";
import { fetchWorkspaceUploadConfig, IMAGE_UPLOAD_FAILURE_MESSAGES, uploadWorkspaceFile } from "./workspaceUploadClient";
import { ATTACHMENT_UPLOAD_FORMAT_LABELS, uploadAdmissionFormatFor } from "@/lib/domain/uploadFormats";

type MutableRef<T> = {
  current: T;
};

function isActiveRunStatus(status: string): boolean {
  return status === "streaming" || status === "queued" || status === "in_progress";
}

type RunFetchOutcome =
  | { kind: "found"; run: RunOutcome }
  | { kind: "not_found" }
  | { kind: "unknown" };

function isTerminalRunFetchOutcome(outcome: RunFetchOutcome): boolean {
  return (
    outcome.kind === "not_found" ||
    (outcome.kind === "found" && !isActiveRunStatus(outcome.run.status))
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wakes the resume owner of a chat (Check run). */
const resumeWakers = new Map<string, () => void>();

type ResumeWake = {
  dispose(): void;
  wait(ms: number): Promise<void>;
};

/**
 * Wake source of one resume owner. Regaining focus, visibility or
 * connectivity and an explicit Check run end the cadence wait early, so a
 * run that settled while the tab was hidden or offline is observed at once.
 * A wake arriving while a check is in flight (connectivity returning during a
 * failing offline read) is remembered for the next wait instead of being lost
 * for a whole cadence.
 */
function createResumeWake(chatId: string): ResumeWake {
  let pending = false;
  let release: (() => void) | null = null;
  const wake = () => {
    if (!release) {
      pending = true;
      return;
    }
    const current = release;
    release = null;
    current();
  };
  const onVisibility = () => {
    if (document.visibilityState === "visible") wake();
  };
  const hasWindow = typeof window !== "undefined";
  const hasDocument = typeof document !== "undefined";
  if (hasWindow) {
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    window.addEventListener("pageshow", wake);
  }
  if (hasDocument) document.addEventListener("visibilitychange", onVisibility);
  resumeWakers.set(chatId, wake);

  return {
    dispose() {
      if (hasWindow) {
        window.removeEventListener("focus", wake);
        window.removeEventListener("online", wake);
        window.removeEventListener("pageshow", wake);
      }
      if (hasDocument) document.removeEventListener("visibilitychange", onVisibility);
      if (resumeWakers.get(chatId) === wake) resumeWakers.delete(chatId);
    },
    wait(ms) {
      if (pending) {
        pending = false;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          release = null;
          resolve();
        }, ms);
        release = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  };
}

const attachmentPolls = new Map<string, Promise<void>>();
const ATTACHMENT_POLL_HORIZON_MS = 15 * 60_000;

function attachmentPollKey(sourceKey: ComposerSessionKey, attachmentId: string): string {
  return `${sourceKey}\u0000${attachmentId}`;
}

function attachmentPollTimeoutMessage(fileName: string): string {
  return `${fileName}: processing is taking longer than expected. Retry status checking or remove the file.`;
}

const UPLOAD_FAILURE_GENERIC_MESSAGE =
  "Upload failed. Try again, or choose another file if it keeps failing.";

/** Names a direct-upload refusal by decoded code first, then by status; never echoes the body. */
async function uploadFailureMessage(response: Response): Promise<string> {
  let decoded: ReturnType<typeof decodeUploadErrorResponse> = null;
  try {
    decoded = decodeUploadErrorResponse(await response.json());
  } catch {
    // Reverse proxies may return a non-JSON body before the application runs.
  }

  switch (decoded?.error) {
    case "pdf_password_required":
      return "Password-protected PDFs are not supported.";
    case "pdf_invalid":
      return "This PDF is damaged or invalid.";
    case "pdf_extraction_timeout":
      return "PDF processing timed out.";
    case "pdf_page_limit_exceeded":
      return `This PDF has more than ${decoded.maxPages} pages.`;
    case "pdf_extraction_failed":
      return "PDF processing failed. Try another PDF.";
    case "upload_busy":
      return "Upload capacity is busy. Try again shortly.";
    case "workspace_runtime_unavailable":
      return "Workspace is unavailable. Turn it off or try again later.";
    case "file_too_large":
      return "File exceeds the configured upload size limit.";
    case "file_required":
      return "The file is empty or couldn't be read. Choose a non-empty file and try again.";
    case "image_invalid":
    case "image_limit_exceeded":
      return IMAGE_UPLOAD_FAILURE_MESSAGES[decoded.error];
    case "unsupported_type":
      return `This file type isn't supported, or its extension doesn't match its contents. Supported: ${ATTACHMENT_UPLOAD_FORMAT_LABELS.join(", ")}. Check that the extension matches the file.`;
    case "project_not_found":
      return "This project is no longer available. Refresh the page or upload the file in another chat.";
    case "unauthorized":
      return "Your session ended. Sign in again to continue.";
    case undefined:
      break;
  }

  if (response.status === 413) {
    return "File exceeds the configured upload size limit.";
  }

  if (response.status === 429) {
    return "Upload capacity is busy. Try again shortly.";
  }

  return UPLOAD_FAILURE_GENERIC_MESSAGE;
}

type RunLifecycleActionsInput = {
  activeChatId: string | null;
  activeChatIdRef: MutableRef<string | null>;
  activeStreamAbortRef: MutableRef<Map<string, AbortController>>;
  notifyAnswerReady(): Promise<void>;
  projectIdForChat?(chatId: string | null): string | null;
  refreshActiveChat(
    chatId: string | null,
    options?: { forceDetail?: boolean; preserveControls?: boolean; resumeRuns?: boolean }
  ): Promise<ChatDetail | null>;
  setNotice: Dispatch<SetStateAction<Notice | null>>;
};

/** Abort owned fetches without clearing ownership needed by their async finally blocks. */
export function abortActiveStreamControllers(controllers: Map<string, AbortController>) {
  for (const controller of controllers.values()) {
    controller.abort();
  }
}

export function useRunLifecycleActions({
  activeChatId,
  activeChatIdRef,
  activeStreamAbortRef,
  notifyAnswerReady,
  projectIdForChat = () => null,
  refreshActiveChat,
  setNotice
}: RunLifecycleActionsInput) {
  function attachmentPath(sourceKey: ComposerSessionKey, attachmentId: string): string {
    const projectId = projectIdFromComposerSessionKey(sourceKey) ??
      projectIdForChat(chatIdFromComposerSessionKey(sourceKey));
    return projectId
      ? `/api/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(attachmentId)}`
      : `/api/uploads/${encodeURIComponent(attachmentId)}`;
  }

  function startAttachmentPoll(sourceKey: ComposerSessionKey, attachmentId: string): void {
    const key = attachmentPollKey(sourceKey, attachmentId);
    if (attachmentPolls.has(key)) return;
    const pending = (async () => {
      const startedAt = Date.now();
      let delayMs = 500;
      while (Date.now() - startedAt < ATTACHMENT_POLL_HORIZON_MS) {
        const store = useComposerSessionStore.getState();
        const staged = selectComposerSession(store, sourceKey).attachments.find(
          (attachment) => attachment.id === attachmentId
        );
        if (!staged || staged.status !== "processing") return;
        await wait(delayMs);
        let response: Response;
        try {
          response = await shellFetch(attachmentPath(sourceKey, attachmentId));
        } catch {
          delayMs = Math.min(Math.round(delayMs * 1.5), 3_000);
          continue;
        }
        if (!response.ok) {
          if (response.status === 404) {
            const currentStore = useComposerSessionStore.getState();
            if (currentStore.updateUploadedAttachment(sourceKey, {
              ...staged,
              processingErrorCode: ATTACHMENT_UNAVAILABLE_ERROR_CODE,
              status: "failed"
            })) {
              currentStore.updateSession(sourceKey, {
                operationError: `${staged.fileName}: attachment is no longer available.`
              });
            }
            return;
          }
          delayMs = Math.min(Math.round(delayMs * 1.5), 3_000);
          continue;
        }
        let body: ReturnType<typeof decodeUploadAttachmentResponse> = null;
        try {
          body = decodeUploadAttachmentResponse(await response.json());
        } catch {
          delayMs = Math.min(Math.round(delayMs * 1.5), 3_000);
          continue;
        }
        if (!body || body.attachment.id !== attachmentId || !body.attachment.status) {
          delayMs = Math.min(Math.round(delayMs * 1.5), 3_000);
          continue;
        }
        if (!useComposerSessionStore.getState().updateUploadedAttachment(sourceKey, body.attachment)) {
          return;
        }
        if (body.attachment.status !== "processing") return;
        delayMs = Math.min(Math.round(delayMs * 1.5), 3_000);
      }
      const store = useComposerSessionStore.getState();
      const staged = selectComposerSession(store, sourceKey).attachments.find(
        (attachment) => attachment.id === attachmentId
      );
      if (staged?.status === "processing") {
        if (store.updateUploadedAttachment(sourceKey, {
          ...staged,
          processingErrorCode: ATTACHMENT_POLL_TIMEOUT_ERROR_CODE,
          status: "failed"
        })) {
          store.updateSession(sourceKey, {
            operationError: attachmentPollTimeoutMessage(staged.fileName)
          });
        }
      }
    })();
    attachmentPolls.set(key, pending);
    const releaseOwnership = () => {
      if (attachmentPolls.get(key) === pending) {
        attachmentPolls.delete(key);
      }
    };
    void pending.then(releaseOwnership, releaseOwnership);
  }

  async function uploadFiles(files: FileList | readonly File[]) {
    const initialStore = useComposerSessionStore.getState();
    const sourceSessionKey = initialStore.activeSessionKey;
    const workspaceEnabled = selectComposerSession(initialStore, sourceSessionKey).workspaceEnabled;
    const generation = initialStore.beginUpload(sourceSessionKey);
    if (generation === null) {
      return;
    }
    const failures: Array<{ fileName: string; message: string }> = [];

    try {
      const limits = workspaceEnabled ? await fetchWorkspaceUploadConfig() : null;
      for (const file of Array.from(files)) {
        try {
          if (!useComposerSessionStore.getState().sessionsByKey[sourceSessionKey]?.pendingUploadGenerations.includes(generation)) break;
          const projectId = projectIdFromComposerSessionKey(sourceSessionKey) ??
            projectIdForChat(chatIdFromComposerSessionKey(sourceSessionKey));
          if (limits && (file.size > limits.ordinaryMaxBytes || !uploadAdmissionFormatFor(file.name, file.type, "attachment"))) {
            if (file.size > limits.maxBytes) throw new Error(`File exceeds the ${Number((limits.maxBytes / 1024 / 1024).toFixed(1))} MiB upload limit.`);
            const attachment = await uploadWorkspaceFile({ file, projectId, sourceKey: sourceSessionKey, generation });
            if (attachment) useComposerSessionStore.getState().appendUploadedAttachment(sourceSessionKey, generation, attachment);
            continue;
          }
          const formData = new FormData();
          formData.append("file", file);
          if (workspaceEnabled) formData.append("scope", "workspace");
          if (projectId) formData.append("projectId", projectId);
          const response = await shellFetch("/api/uploads", {
            body: formData,
            method: "POST"
          });

          if (!response.ok) {
            throw new Error(await uploadFailureMessage(response));
          }

          const body = decodeUploadAttachmentResponse(await response.json());
          if (!body) {
            throw new Error("upload_malformed");
          }

          const appended = useComposerSessionStore
            .getState()
            .appendUploadedAttachment(sourceSessionKey, generation, body.attachment);
          if (appended && body.attachment.status === "processing") {
            startAttachmentPoll(sourceSessionKey, body.attachment.id);
          }
        } catch (error) {
          failures.push({
            fileName: file.name || "Unnamed file",
            message: errorMessage(error)
          });
        }
      }
    } catch {
      failures.push({ fileName: "Files", message: "Upload settings are unavailable. Try again shortly." });
    } finally {
      const operationError = failures.length
        ? failures.length === 1
          ? `${failures[0]!.fileName}: ${failures[0]!.message}`
          : `${failures.length} files failed to upload: ${failures.map((failure) => failure.fileName).join(", ")}. ${failures[0]!.message}`
        : null;
      useComposerSessionStore
        .getState()
        .finishUpload(sourceSessionKey, generation, operationError);
    }
  }

  async function reuseFile(
    attachmentId: string,
    prepareAttachment?: (attachment: UploadedAttachmentWire) => Promise<boolean>
  ): Promise<boolean> {
    const store = useComposerSessionStore.getState();
    const sourceKey = store.activeSessionKey;
    if (projectIdFromComposerSessionKey(sourceKey) || projectIdForChat(chatIdFromComposerSessionKey(sourceKey))) return false;
    const generation = store.beginUpload(sourceKey);
    if (generation === null) return false;
    let failure: string | null = null;
    try {
      const response = await shellFetch(`/api/uploads/${encodeURIComponent(attachmentId)}/reuse`, { method: "POST" });
      const body = decodeUploadAttachmentResponse(await response.json().catch(() => null));
      if (!response.ok || !body) throw new Error("file_reuse_failed");
      if (prepareAttachment && !(await prepareAttachment(body.attachment))) throw new Error("file_reuse_unavailable");
      const appended = useComposerSessionStore.getState().appendUploadedAttachment(sourceKey, generation, body.attachment);
      if (appended && body.attachment.status === "processing") startAttachmentPoll(sourceKey, body.attachment.id);
      return appended;
    } catch {
      failure = "This file could not be attached. Try again or choose another file.";
      return false;
    } finally {
      useComposerSessionStore.getState().finishUpload(sourceKey, generation, failure);
    }
  }

  async function retryAttachment(attachmentId: string): Promise<void> {
    const store = useComposerSessionStore.getState();
    const sourceSessionKey = store.activeSessionKey;
    const attachment = selectComposerSession(store, sourceSessionKey).attachments.find(
      (candidate) => candidate.id === attachmentId
    );
    if (
      !attachment ||
      attachment.status !== "failed" ||
      !attachmentRetryAvailable(attachment)
    ) return;
    if (attachment.processingErrorCode === ATTACHMENT_POLL_TIMEOUT_ERROR_CODE) {
      attachmentPolls.delete(attachmentPollKey(sourceSessionKey, attachmentId));
      if (store.updateUploadedAttachment(sourceSessionKey, {
        ...attachment,
        processingErrorCode: null,
        status: "processing"
      })) {
        store.updateSession(sourceSessionKey, (current) => ({
          operationError: current.operationError === attachmentPollTimeoutMessage(attachment.fileName)
            ? null
            : current.operationError
        }));
        startAttachmentPoll(sourceSessionKey, attachmentId);
      }
      return;
    }
    try {
      const response = await shellFetch(attachmentPath(sourceSessionKey, attachmentId), {
        method: "POST"
      });
      if (!response.ok) throw new Error(`attachment_retry_failed_${response.status}`);
      const body = decodeUploadAttachmentResponse(await response.json());
      if (!body || body.attachment.id !== attachmentId || body.attachment.status !== "processing") {
        throw new Error("attachment_retry_malformed");
      }
      if (useComposerSessionStore.getState().updateUploadedAttachment(sourceSessionKey, body.attachment)) {
        attachmentPolls.delete(attachmentPollKey(sourceSessionKey, attachmentId));
        startAttachmentPoll(sourceSessionKey, attachmentId);
      }
    } catch (error) {
      useComposerSessionStore.getState().updateSession(sourceSessionKey, {
        operationError: `${attachment.fileName}: ${errorMessage(error)}`
      });
    }
  }

  async function requestRunOutcome(runId: string, chatId: string): Promise<RunFetchOutcome> {
    try {
      const { response, body } = await shellReadJson(`/api/model-runs/${runId}`);
      if (!response.ok) {
        return response.status === 404 ? { kind: "not_found" } : { kind: "unknown" };
      }

      const run = decodeRunOutcomeResponse(body);
      if (!run || run.id !== runId) {
        throw new Error("run_malformed");
      }

      return { kind: "found", run };
    } catch (error) {
      if (activeChatIdRef.current === chatId) {
        setNotice({
          kind: "error",
          text: errorMessage(error)
        });
      }
      return { kind: "unknown" };
    }
  }

  async function fetchRunOutcome(
    runId: string,
    chatId: string,
    producer?: string
  ): Promise<RunFetchOutcome> {
    const outcome = await requestRunOutcome(runId, chatId);
    if (outcome.kind !== "found") return outcome;
    const { run } = outcome;
    useThreadStore.getState().updateMessages(chatId, (messages) => messages.map((message) => message.runId === run.id
      ? { ...message, ...(run.answerComplete ? { status: "complete" as const } : {}),
          ...(run.followups ? { followups: run.followups } : {}),
          workspacePreparation: run.workspacePreparation,
          workspaceSettling: run.answerComplete && isActiveRunStatus(run.status) ? true : undefined }
      : message));
    if (run.pdfPreparation) useThreadStore.getState().updateMessages(chatId, (messages) => messages.map((message) => {
      if (message.runId !== run.id) return message;
      const current = message.pdfPreparation;
      const next = run.pdfPreparation!;
      const currentCount = current?.reduce((sum, item) => sum + item.completedPages, 0) ?? 0;
      const nextCount = next.reduce((sum, item) => sum + item.completedPages, 0);
      const wasTerminal = current?.some((item) => item.phase === "failed" || item.phase === "cancelled");
      if (nextCount < currentCount || wasTerminal && !next.some((item) => item.phase === "failed" || item.phase === "cancelled")) return message;
      return { ...message, pdfPreparation: next };
    }));
    // Only the record's own producer may bind a run id to it; any other
    // caller merely confirms answer completion of the run the record already
    // names. The store enforces both rules.
    const lifecycle = useRunLifecycleStore.getState();
    if (producer) lifecycle.runIdReceived({ chatId, producer, runId: run.id });
    if (run.answerComplete) {
      lifecycle.answerCompleted({ chatId, ...(producer ? { producer } : {}), runId: run.id });
    }
    return { kind: "found", run };
  }

  async function fetchRun(runId: string, chatId: string, options: { producer?: string } = {}) {
    const outcome = await fetchRunOutcome(runId, chatId, options.producer);
    return outcome.kind === "found" ? outcome.run : null;
  }

  function ownsResume(chatId: string, runId: string): boolean {
    const stream = useRunLifecycleStore.getState().activeStreams[chatId];
    return stream?.resuming === true && stream.runId === runId;
  }

  async function inspectResumedRun(chat: WorkspaceChatSummary, runId: string): Promise<RunFetchOutcome> {
    const outcome = await fetchRunOutcome(runId, chat.id);
    await refreshActiveChat(chat.id, { preserveControls: true, resumeRuns: false });
    return outcome;
  }

  async function resumeChatRun(chat: WorkspaceChatSummary) {
    const runId = latestResumableRunId(
      selectThreadSnapshot(useThreadStore.getState(), chat.id)
    );
    if (!runId || !useRunLifecycleStore.getState().resumeStarted({ chatId: chat.id, runId })) {
      return;
    }

    let answerNotified = selectThreadSnapshot(useThreadStore.getState(), chat.id).messages.some(
      (message) => message.runId === runId && message.workspaceSettling);
    if (answerNotified) useRunLifecycleStore.getState().answerCompleted({ chatId: chat.id, runId });
    const resumeWake = createResumeWake(chat.id);
    try {
      let startedAt = Date.now();
      let delayMs = RESUME_POLL_INITIAL_DELAY_MS;

      // Frequent polling up to the horizon, then rare checks until the run is
      // terminal: the gate (and its Stop) never outlives observation, and a
      // long run still releases the chat on its own. Unknown reads (offline,
      // 5xx) are not terminal. Leaving the chat ends the loop within one
      // cadence; returning to it starts a new owner.
      for (;;) {
        if (
          activeChatIdRef.current !== chat.id ||
          useRunLifecycleStore.getState().cancelledRunIds.has(runId) ||
          !ownsResume(chat.id, runId)
        ) {
          return;
        }

        const outcome = await inspectResumedRun(chat, runId);
        if (outcome.kind === "found" && outcome.run.answerComplete && !answerNotified) {
          answerNotified = true;
          void notifyAnswerReady();
        }
        if (outcome.kind === "found" && outcome.run.pdfPreparation &&
          (outcome.run.status === "queued" || outcome.run.pdfPreparation.some((item) =>
            ["checking", "preparing", "assembling"].includes(item.phase)))) startedAt = Date.now();
        if (isTerminalRunFetchOutcome(outcome)) {
          if (outcome.kind === "found" && outcome.run.status === "complete" && !answerNotified) {
            void notifyAnswerReady();
          }
          return;
        }

        const background = Date.now() - startedAt >= RESUME_POLL_HORIZON_MS;
        if (background && ownsResume(chat.id, runId)) {
          useRunLifecycleStore.getState().resumeBackgrounded({ chatId: chat.id, runId });
        }
        await resumeWake.wait(background ? RESUME_POLL_BACKGROUND_DELAY_MS : delayMs);
        delayMs = Math.min(Math.round(delayMs * 1.6), RESUME_POLL_MAX_DELAY_MS);
      }
    } finally {
      resumeWake.dispose();
      useRunLifecycleStore.getState().resumeExited({ chatId: chat.id, runId });

      if (activeChatIdRef.current === chat.id) {
        await refreshActiveChat(chat.id, { preserveControls: true, resumeRuns: false });
      }
    }
  }

  /** Checks the chat's background run now instead of at its next cadence. */
  function checkBackgroundRun(chatId: string) {
    resumeWakers.get(chatId)?.();
  }

  async function stopCurrentRun(expectedRunId?: string | null) {
    const sourceChatId = activeChatId;
    if (!sourceChatId) return;

    const lifecycle = useRunLifecycleStore.getState();
    const stream = lifecycle.activeStreams[sourceChatId];
    const interrupted = lifecycle.ambiguousFailures[sourceChatId];
    const runId = stream ? stream.runId : interrupted?.runId;
    if (!runId || (expectedRunId !== undefined && expectedRunId !== runId)) return;
    if (!lifecycle.stopStarted(runId)) return;

    const assistantMessageId = stream?.optimisticAssistantMessageId ?? interrupted?.assistantMessageId;
    const sourceAbortController = activeStreamAbortRef.current.get(sourceChatId);
    const stillOwnsSource = (): boolean => {
      const current = useRunLifecycleStore.getState();
      const producer = current.activeStreams[sourceChatId];
      if (producer) return producer.runId === runId;
      const failure = current.ambiguousFailures[sourceChatId];
      return failure?.runId === runId && failure?.assistantMessageId === assistantMessageId;
    };

    try {
      const response = await shellFetch(`/api/model-runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST"
      });
      const result = decodeCancelModelRunResponse(await response.json());
      const expectedStatus =
        (result?.kind === "cancelled" && response.status === 200) ||
        (result?.kind === "not_cancelled" && response.status === 409);
      if (!result || result.run.id !== runId || !expectedStatus) {
        throw new Error(response.ok ? "cancel_malformed" : `cancel_failed_${response.status}`);
      }
      // A delayed response belongs only to the recorded run, even if a new
      // producer has since taken over and finished in this same chat.
      if (!stillOwnsSource()) return;

      if (result.kind === "cancelled") {
        sourceAbortController?.abort();
        if (activeStreamAbortRef.current.get(sourceChatId) === sourceAbortController) {
          activeStreamAbortRef.current.delete(sourceChatId);
        }
        useRunLifecycleStore.getState().runCancelled({ chatId: sourceChatId, runId });
        useRunSurfaceStore.getState().appendEvent(sourceChatId, {
          data: { runId, status: "cancelled" },
          type: "done"
        });
        if (assistantMessageId) {
          useThreadStore.getState().updateMessages(sourceChatId, (current) =>
            current.map((message) =>
              message.id === assistantMessageId &&
              (message.status === "streaming" || message.status === "error")
                ? {
                    ...message,
                    content: textFromThreadContent(message.content) || "Stopped.",
                    status: "cancelled"
                  }
                : message
            )
          );
        }
      } else if (!isActiveRunStatus(result.run.status)) {
        useRunLifecycleStore.getState().streamFinished({ chatId: sourceChatId, runId });
        useRunLifecycleStore.getState().ambiguityCleared({ chatId: sourceChatId });
      } else if (interrupted && activeChatIdRef.current === sourceChatId) {
        setNotice({ kind: "error", text: "Couldn’t stop the answer. Refresh to check its state." });
      }

      if (activeChatIdRef.current === sourceChatId) {
        await refreshActiveChat(sourceChatId, { preserveControls: true, resumeRuns: false });
      }
    } catch (error) {
      if (!stillOwnsSource()) return;
      if (activeChatIdRef.current === sourceChatId) {
        setNotice({
          kind: "error",
          text: interrupted
            ? "Couldn’t stop the answer. Refresh to check its state."
            : errorMessage(error)
        });
      }
    } finally {
      useRunLifecycleStore.getState().stopFinished(runId);
    }
  }

  return {
    checkBackgroundRun,
    fetchRun,
    retryAttachment,
    reuseFile,
    resumeChatRun,
    stopCurrentRun,
    uploadFiles
  };
}
