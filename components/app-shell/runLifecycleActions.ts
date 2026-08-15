import {
  type ComposerSessionKey,
  selectComposerSession,
  useComposerSessionStore
} from "@/components/app-shell/composerSessionStore";
import {
  attachmentRetryAvailable,
  ATTACHMENT_POLL_TIMEOUT_ERROR_CODE,
  ATTACHMENT_UNAVAILABLE_ERROR_CODE
} from "@/components/app-shell/attachmentLifecycle";
import { shellFetch } from "@/components/app-shell/shellApi";
import { errorMessage } from "@/components/app-shell/shellFormatting";
import { textFromThreadContent } from "@/components/app-shell/threadContent";
import { latestResumableRunId } from "@/components/app-shell/threadPath";
import type { ChatDetail, WorkspaceChatSummary, Notice } from "@/components/app-shell/types";
import {
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
import { decodeUploadAttachmentResponse, decodeUploadErrorResponse } from "@/lib/contracts/uploads";
import type { Dispatch, SetStateAction } from "react";

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

const attachmentPolls = new Map<string, Promise<void>>();
const ATTACHMENT_POLL_HORIZON_MS = 15 * 60_000;

function attachmentPollKey(sourceKey: ComposerSessionKey, attachmentId: string): string {
  return `${sourceKey}\u0000${attachmentId}`;
}

function attachmentPollTimeoutMessage(fileName: string): string {
  return `${fileName}: processing is taking longer than expected. Retry status checking or remove the file.`;
}

async function uploadFailureMessage(response: Response): Promise<string> {
  let decoded: ReturnType<typeof decodeUploadErrorResponse> = null;
  try {
    decoded = decodeUploadErrorResponse(await response.json());
  } catch {
    // Reverse proxies may return a non-JSON body before the application runs.
  }

  if (decoded?.error === "pdf_password_required") {
    return "Password-protected PDFs are not supported.";
  }

  if (decoded?.error === "pdf_invalid") {
    return "This PDF is damaged or invalid.";
  }

  if (decoded?.error === "pdf_extraction_timeout") {
    return "PDF processing timed out.";
  }

  if (decoded?.error === "pdf_page_limit_exceeded") {
    return `This PDF has more than ${decoded.maxPages} pages.`;
  }

  if (decoded?.error === "pdf_extraction_failed") {
    return "PDF processing failed. Try another PDF.";
  }

  if (decoded?.error === "upload_busy" || response.status === 429) {
    return "Upload capacity is busy. Try again shortly.";
  }

  if (decoded?.error === "file_too_large" || response.status === 413) {
    return "File exceeds the configured upload size limit.";
  }

  return `upload_failed_${response.status}`;
}

type RunLifecycleActionsInput = {
  activeChatId: string | null;
  activeChatIdRef: MutableRef<string | null>;
  activeStreamAbortRef: MutableRef<Map<string, AbortController>>;
  notifyAnswerReady(): Promise<void>;
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
  refreshActiveChat,
  setNotice
}: RunLifecycleActionsInput) {
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
          response = await shellFetch(`/api/uploads/${encodeURIComponent(attachmentId)}`);
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
    const sourceSessionKey = useComposerSessionStore.getState().activeSessionKey;
    const generation = useComposerSessionStore.getState().beginUpload(sourceSessionKey);
    if (generation === null) {
      return;
    }
    const failures: Array<{ fileName: string; message: string }> = [];

    try {
      for (const file of Array.from(files)) {
        try {
          const formData = new FormData();
          formData.append("file", file);
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
      const response = await shellFetch(`/api/uploads/${encodeURIComponent(attachmentId)}`, {
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
      const response = await shellFetch(`/api/model-runs/${runId}`);
      if (!response.ok) {
        return response.status === 404 ? { kind: "not_found" } : { kind: "unknown" };
      }

      const run = decodeRunOutcomeResponse(await response.json());
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

  async function fetchRunOutcome(runId: string, chatId: string): Promise<RunFetchOutcome> {
    const outcome = await requestRunOutcome(runId, chatId);
    if (outcome.kind !== "found") return outcome;
    const { run } = outcome;
    const activeStream = useRunLifecycleStore.getState().activeStreams[chatId];
    if (activeStream && (!activeStream.runId || activeStream.runId === run.id)) {
      useRunLifecycleStore.getState().runIdReceived({ chatId, runId: run.id });
    }
    return { kind: "found", run };
  }

  async function fetchRun(runId: string, chatId: string) {
    const outcome = await fetchRunOutcome(runId, chatId);
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

    let retainResumeGate = false;
    try {
      const startedAt = Date.now();
      let delayMs = RESUME_POLL_INITIAL_DELAY_MS;

      while (Date.now() - startedAt < RESUME_POLL_HORIZON_MS) {
        if (
          activeChatIdRef.current !== chat.id ||
          useRunLifecycleStore.getState().cancelledRunIds.has(runId) ||
          !ownsResume(chat.id, runId)
        ) {
          return;
        }

        const outcome = await inspectResumedRun(chat, runId);
        if (isTerminalRunFetchOutcome(outcome)) {
          if (outcome.kind === "found" && outcome.run.status === "complete") {
            void notifyAnswerReady();
          }
          return;
        }

        await wait(delayMs);
        delayMs = Math.min(Math.round(delayMs * 1.6), RESUME_POLL_MAX_DELAY_MS);
      }

      if (
        activeChatIdRef.current === chat.id &&
        !useRunLifecycleStore.getState().cancelledRunIds.has(runId) &&
        ownsResume(chat.id, runId)
      ) {
        retainResumeGate = true;
        setNotice({
          action: {
            label: "Check run",
            onClick: () => {
              void (async () => {
                const outcome = await inspectResumedRun(chat, runId);
                if (isTerminalRunFetchOutcome(outcome) && ownsResume(chat.id, runId)) {
                  useRunLifecycleStore.getState().resumeExited({ chatId: chat.id, runId });
                  if (outcome.kind === "found" && outcome.run.status === "complete") {
                    void notifyAnswerReady();
                  }
                }
              })();
            }
          },
          kind: "error",
          text: "Run is still active in the background."
        });
      }
    } finally {
      if (!retainResumeGate) {
        useRunLifecycleStore.getState().resumeExited({ chatId: chat.id, runId });
      }

      if (activeChatIdRef.current === chat.id) {
        await refreshActiveChat(chat.id, { preserveControls: true, resumeRuns: false });
      }
    }
  }

  async function stopCurrentRun() {
    const sourceChatId = activeChatId;
    if (!sourceChatId) {
      return;
    }

    const { activeStreams } = useRunLifecycleStore.getState();
    const stream = activeStreams[sourceChatId];
    if (!stream) {
      return;
    }

    const runId = stream.runId;
    const assistantMessageId = stream.optimisticAssistantMessageId;
    const sourceAbortController = activeStreamAbortRef.current.get(sourceChatId);

    if (runId) {
      try {
        const response = await shellFetch(`/api/model-runs/${runId}/cancel`, {
          method: "POST"
        });
        const result = decodeCancelModelRunResponse(await response.json());
        const expectedStatus =
          (result?.kind === "cancelled" && response.status === 200) ||
          (result?.kind === "not_cancelled" && response.status === 409);
        if (!result || result.run.id !== runId || !expectedStatus) {
          throw new Error(response.ok ? "cancel_malformed" : `cancel_failed_${response.status}`);
        }

        const currentStream = useRunLifecycleStore.getState().activeStreams[sourceChatId];
        const stillOwnsSource = !currentStream || currentStream.runId === runId;
        if (result.kind === "cancelled" && stillOwnsSource) {
          sourceAbortController?.abort();
          if (activeStreamAbortRef.current.get(sourceChatId) === sourceAbortController) {
            activeStreamAbortRef.current.delete(sourceChatId);
          }
          useRunLifecycleStore.getState().runCancelled({ chatId: sourceChatId, runId });
          useRunSurfaceStore.getState().appendEvent(sourceChatId, {
            data: {
              runId,
              status: "cancelled"
            },
            type: "done"
          });
          if (assistantMessageId) {
            useThreadStore.getState().updateMessages(sourceChatId, (current) =>
              current.map((message) =>
                message.id === assistantMessageId && message.status === "streaming"
                  ? {
                      ...message,
                      content: textFromThreadContent(message.content) || "Stopped.",
                      status: "cancelled"
                    }
                  : message
              )
            );
          }
        } else if (
          result.kind === "not_cancelled" &&
          stillOwnsSource &&
          !isActiveRunStatus(result.run.status)
        ) {
          useRunLifecycleStore.getState().streamFinished({ chatId: sourceChatId });
        }

        await fetchRun(runId, sourceChatId);
      } catch (error) {
        if (activeChatIdRef.current === sourceChatId) {
          setNotice({
            kind: "error",
            text: errorMessage(error)
          });
        }
        await fetchRun(runId, sourceChatId);
      }
    }

    if (activeChatIdRef.current === sourceChatId) {
      await refreshActiveChat(sourceChatId, { preserveControls: true, resumeRuns: false });
    }
  }

  return {
    fetchRun,
    retryAttachment,
    resumeChatRun,
    stopCurrentRun,
    uploadFiles
  };
}
