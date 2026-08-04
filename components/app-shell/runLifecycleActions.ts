import { useComposerSessionStore } from "@/components/app-shell/composerSessionStore";
import { shellFetch } from "@/components/app-shell/shellApi";
import { errorMessage } from "@/components/app-shell/shellFormatting";
import { isRecord } from "@/components/app-shell/shellValues";
import { textFromThreadContent } from "@/components/app-shell/threadContent";
import { latestResumableRunId } from "@/components/app-shell/threadPath";
import type { ChatDetail, ChatSummary, Notice } from "@/components/app-shell/types";
import {
  RESUME_POLL_HORIZON_MS,
  RESUME_POLL_INITIAL_DELAY_MS,
  RESUME_POLL_MAX_DELAY_MS
} from "@/components/app-shell/powerAppShellData";
import { useRunLifecycleStore } from "@/components/app-shell/runLifecycleStore";
import {
  selectRunSurface,
  useRunSurfaceStore
} from "@/components/app-shell/runSurfaceStore";
import { selectThreadSnapshot, useThreadStore } from "@/components/app-shell/threadStore";
import {
  decodeCancelModelRunResponse,
  decodeGetModelRunResponse,
  type PersistedRun
} from "@/lib/contracts/runs";
import { decodeUploadAttachmentResponse, decodeUploadErrorResponse } from "@/lib/contracts/uploads";
import type { Dispatch, SetStateAction } from "react";

type MutableRef<T> = {
  current: T;
};

function isActivePersistedRunStatus(status: string): boolean {
  return status === "streaming" || status === "queued" || status === "in_progress";
}

type RunFetchOutcome =
  | { kind: "found"; run: PersistedRun }
  | { kind: "not_found" }
  | { kind: "unknown" };

function isTerminalRunFetchOutcome(outcome: RunFetchOutcome): boolean {
  return (
    outcome.kind === "not_found" ||
    (outcome.kind === "found" && !isActivePersistedRunStatus(outcome.run.status))
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadFailureMessage(response: Response): Promise<string> {
  let decoded: ReturnType<typeof decodeUploadErrorResponse> = null;
  try {
    decoded = decodeUploadErrorResponse(await response.json());
  } catch {
    // Reverse proxies may return a non-JSON body before the application runs.
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

          useComposerSessionStore
            .getState()
            .appendUploadedAttachment(sourceSessionKey, generation, body.attachment);
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

  async function fetchRunOutcome(runId: string, chatId: string): Promise<RunFetchOutcome> {
    const surfaceAtRequest = selectRunSurface(useRunSurfaceStore.getState(), chatId);
    try {
      const response = await shellFetch(`/api/model-runs/${runId}`);
      if (!response.ok) {
        return response.status === 404 ? { kind: "not_found" } : { kind: "unknown" };
      }

      const run = decodeGetModelRunResponse(await response.json());
      if (!run) {
        throw new Error("run_malformed");
      }

      const activeStream = useRunLifecycleStore.getState().activeStreams[chatId];
      const currentSurface = selectRunSurface(useRunSurfaceStore.getState(), chatId);
      if (
        (activeStream && activeStream.runId !== run.id) ||
        (!activeStream && currentSurface !== surfaceAtRequest && currentSurface.lastRun?.id !== run.id)
      ) {
        return { kind: "found", run };
      }

      useRunLifecycleStore.getState().runIdReceived({ chatId, runId: run.id });
      useRunSurfaceStore.getState().replaceSurface(chatId, {
        events: run.events.map((event) => ({
          data:
            event.eventType === "usage" && isRecord(event.payload)
              ? {
                  ...event.payload,
                  estimatedCostMicros: run.estimatedCostMicros
                }
              : event.payload,
          type: event.eventType
        })),
        lastRun: run
      });

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

  async function fetchRun(runId: string, chatId: string) {
    const outcome = await fetchRunOutcome(runId, chatId);
    return outcome.kind === "found" ? outcome.run : null;
  }

  function ownsResume(chatId: string, runId: string): boolean {
    const stream = useRunLifecycleStore.getState().activeStreams[chatId];
    return stream?.resuming === true && stream.runId === runId;
  }

  async function inspectResumedRun(chat: ChatSummary, runId: string): Promise<RunFetchOutcome> {
    const outcome = await fetchRunOutcome(runId, chat.id);
    await refreshActiveChat(chat.id, { preserveControls: true, resumeRuns: false });
    return outcome;
  }

  async function resumeChatRun(chat: ChatSummary) {
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
          !isActivePersistedRunStatus(result.run.status)
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
    resumeChatRun,
    stopCurrentRun,
    uploadFiles
  };
}
