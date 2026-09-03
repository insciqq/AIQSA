import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetComposerSessionStoreForTest,
  resetRunLifecycleStoreForTest,
  resetRunSurfaceStoreForTest,
  resetThreadStoreForTest
} from "@/tests/support/appShellStores";
import {
  composerSessionKey,
  projectComposerSessionKey,
  selectComposerSession,
  useComposerSessionStore
} from "./composerSessionStore";
import {
  abortActiveStreamControllers,
  useRunLifecycleActions
} from "./runLifecycleActions";
import { useRunLifecycleStore } from "./runLifecycleStore";
import {
  selectRunSurface,
  useRunSurfaceStore
} from "./runSurfaceStore";
import { useThreadStore } from "./threadStore";
import type { WorkspaceChatSummary, Notice, ThreadMessage } from "./types";

function message(overrides: Partial<ThreadMessage>): ThreadMessage {
  return {
    content: "",
    id: "message-1",
    modelId: "fake-model",
    parentMessageId: null,
    provider: "fake",
    role: "user",
    runId: null,
    status: "complete",
    ...overrides
  };
}

function streamingChat(): WorkspaceChatSummary {
  return {
    activeLeafMessageId: "assistant-1",
    createdAt: "2026-06-10T00:00:00.000Z",
    defaultModelId: "fake-model",
    defaultProvider: "fake",
    folderId: null,
    id: "chat-1",
    messageCount: 2,
    title: "Streaming chat",
    updatedAt: "2026-06-10T00:00:00.000Z"
  };
}

function useRunLifecycleActionsForTest(
  overrides: { activeChatId?: string | null; streamChatId?: string | null } = {}
) {
  resetRunLifecycleStoreForTest();
  resetRunSurfaceStoreForTest();
  resetComposerSessionStoreForTest();
  resetThreadStoreForTest();
  useThreadStore.getState().replaceThread("chat-1", {
    activeLeafId: "assistant-1",
    messages: [
      message({ content: "Question", id: "user-1" }),
      message({
        id: "assistant-1",
        parentMessageId: "user-1",
        role: "assistant",
        runId: "run-1",
        status: "streaming"
      })
    ],
    usageStats: null
  });
  if (overrides.streamChatId) {
    useRunLifecycleStore.setState({
      activeStreams: {
        [overrides.streamChatId]: {
          optimisticAssistantMessageId: null,
          resuming: false,
          runId: "run-existing"
        }
      }
    });
  }
  const selectedChatId = overrides.activeChatId ?? "chat-1";
  const activeChatIdRef = { current: selectedChatId };
  useComposerSessionStore.getState().activateSession(composerSessionKey(selectedChatId));
  const noticeRef: { current: Notice | null } = { current: null };
  const refreshActiveChat = vi.fn(async () => null);
  const notifyAnswerReady = vi.fn(async () => undefined);
  const activeStreamAbortRef = { current: new Map<string, AbortController>() };
  const actions = useRunLifecycleActions({
    activeChatId: selectedChatId,
    activeChatIdRef,
    activeStreamAbortRef,
    notifyAnswerReady,
    refreshActiveChat,
    setNotice(update) {
      noticeRef.current = typeof update === "function" ? update(noticeRef.current) : update;
    }
  });

  return {
    actions,
    activeChatIdRef,
    activeStreamAbortRef,
    composerSession: (chatId: string) =>
      selectComposerSession(useComposerSessionStore.getState(), composerSessionKey(chatId)),
    notice: () => noticeRef.current,
    notifyAnswerReady,
    refreshActiveChat,
    surface: (chatId: string) => selectRunSurface(useRunSurfaceStore.getState(), chatId)
  };
}

function runResponse(
  status: "cancelled" | "complete" | "error" | "in_progress" | "queued" | "streaming" = "complete"
) {
  return {
    run: {
      id: "run-1",
      status
    },
    version: 1
  };
}

describe("active stream cleanup", () => {
  it("aborts every client stream while preserving ownership for async finalizers", () => {
    const first = new AbortController();
    const second = new AbortController();
    const controllers = new Map([
      ["chat-1", first],
      ["chat-2", second]
    ]);

    abortActiveStreamControllers(controllers);

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(controllers.get("chat-1")).toBe(first);
    expect(controllers.get("chat-2")).toBe(second);
  });
});

describe("run lifecycle actions", () => {
  afterEach(() => {
    resetRunLifecycleStoreForTest();
    resetRunSurfaceStoreForTest();
    resetComposerSessionStoreForTest();
    resetThreadStoreForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("removes the keyed resume owner after switching away", async () => {
    const { actions, refreshActiveChat } = useRunLifecycleActionsForTest({
      activeChatId: "other-chat"
    });

    await actions.resumeChatRun(streamingChat());

    expect(useRunLifecycleStore.getState().activeStreams).toEqual({});
    expect(refreshActiveChat).not.toHaveBeenCalled();
  });

  it("uploads a local blank-Project file under Project ownership before a chat exists", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      attachment: {
        fileName: "shared.pdf",
        id: "attachment-project",
        kind: "pdf",
        status: "ready"
      }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { actions } = useRunLifecycleActionsForTest();
    const sourceKey = projectComposerSessionKey("project/one");
    useComposerSessionStore.getState().activateSession(sourceKey);

    await actions.uploadFiles([new File(["shared"], "shared.pdf", { type: "application/pdf" })]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("projectId")).toBe("project/one");
    expect(selectComposerSession(useComposerSessionStore.getState(), sourceKey).attachments)
      .toEqual([expect.objectContaining({ id: "attachment-project", status: "ready" })]);
  });

  it("does not start resume polling while the same chat has a stream producer", async () => {
    const { actions } = useRunLifecycleActionsForTest({
      streamChatId: "chat-1"
    });

    await actions.resumeChatRun(streamingChat());

    expect(useRunLifecycleStore.getState().activeStreams).toEqual({
      "chat-1": {
        optimisticAssistantMessageId: null,
        resuming: false,
        runId: "run-existing"
      }
    });
  });

  it("keeps unknown and active resume reads gated until a later terminal read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T00:00:00.000Z"));
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network disconnected"))
      .mockResolvedValueOnce(Response.json(runResponse("streaming")))
      .mockResolvedValueOnce(Response.json(runResponse("complete")));
    vi.stubGlobal("fetch", fetchMock);
    const { actions, composerSession, notifyAnswerReady } = useRunLifecycleActionsForTest();
    useComposerSessionStore.getState().activateSession(composerSessionKey("chat-2"));
    useComposerSessionStore.getState().setDraft("Draft B");
    useComposerSessionStore.getState().activateSession(composerSessionKey("chat-1"));
    useRunLifecycleStore.getState().streamStarted({
      assistantMessageId: "assistant-2",
      chatId: "chat-2",
      runId: "run-2"
    });

    const resume = actions.resumeChatRun(streamingChat());
    await vi.advanceTimersByTimeAsync(0);
    expect(useRunLifecycleStore.getState().activeStreams["chat-1"]).toMatchObject({
      resuming: true,
      runId: "run-1"
    });
    await vi.advanceTimersByTimeAsync(1500);
    expect(useRunLifecycleStore.getState().activeStreams["chat-1"]).toMatchObject({
      resuming: true,
      runId: "run-1"
    });
    await vi.advanceTimersByTimeAsync(2400);
    await resume;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(useRunLifecycleStore.getState().activeStreams["chat-1"]).toBeUndefined();
    expect(useRunLifecycleStore.getState().activeStreams["chat-2"]).toMatchObject({
      runId: "run-2"
    });
    expect(composerSession("chat-2")).toMatchObject({ draft: "Draft B" });
    expect(notifyAnswerReady).toHaveBeenCalledOnce();
  });

  it("treats a proven missing run as terminal and releases only its source gate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "model_run_not_found" }, { status: 404 }))
    );
    const { actions } = useRunLifecycleActionsForTest();
    useRunLifecycleStore.getState().streamStarted({
      assistantMessageId: "assistant-2",
      chatId: "chat-2",
      runId: "run-2"
    });

    await actions.resumeChatRun(streamingChat());

    expect(useRunLifecycleStore.getState().activeStreams).toEqual({
      "chat-2": {
        optimisticAssistantMessageId: "assistant-2",
        resuming: false,
        runId: "run-2"
      }
    });
  });

  it("retains an unknown source gate at the polling horizon until Check run proves terminal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T00:00:00.000Z"));
    let terminal = false;
    const fetchMock = vi.fn(async () =>
      terminal
        ? Response.json(runResponse("error"))
        : new Response("upstream unavailable", { status: 502 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { actions, notice, notifyAnswerReady } = useRunLifecycleActionsForTest();

    const resume = actions.resumeChatRun(streamingChat());
    await vi.runAllTimersAsync();
    await resume;

    expect(useRunLifecycleStore.getState().activeStreams["chat-1"]).toEqual({
      optimisticAssistantMessageId: null,
      resuming: true,
      runId: "run-1"
    });
    expect(notice()).toMatchObject({
      action: { label: "Check run" },
      kind: "error",
      text: "Run is still active in the background."
    });

    terminal = true;
    notice()?.action?.onClick();
    await vi.runAllTimersAsync();

    expect(useRunLifecycleStore.getState().activeStreams["chat-1"]).toBeUndefined();
    expect(notifyAnswerReady).not.toHaveBeenCalled();
  });

  it("returns a late outcome without painting it into any chat surface", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { actions, activeChatIdRef, surface } = useRunLifecycleActionsForTest();
    useRunSurfaceStore.getState().appendEvent("chat-2", {
      data: { runId: "run-2" },
      type: "start"
    });

    const fetchPromise = actions.fetchRun("run-1", "chat-1");
    activeChatIdRef.current = "chat-2";
    resolveFetch(
      new Response(JSON.stringify(runResponse()), {
        headers: {
          "content-type": "application/json"
        },
        status: 200
      })
    );

    await expect(fetchPromise).resolves.toMatchObject({
      id: "run-1"
    });
    expect(surface("chat-1")).toMatchObject({ events: [] });
    expect(surface("chat-2")).toMatchObject({
      events: [{ data: { runId: "run-2" }, type: "start" }]
    });

    const staleFetch = actions.fetchRun("run-1", "chat-1");
    useRunSurfaceStore.getState().resetSurface("chat-1");
    useRunLifecycleStore.getState().streamStarted({
      chatId: "chat-1",
      runId: "run-new"
    });
    resolveFetch(
      new Response(JSON.stringify(runResponse()), {
        headers: { "content-type": "application/json" },
        status: 200
      })
    );

    await expect(staleFetch).resolves.toMatchObject({ id: "run-1" });
    expect(surface("chat-1")).toMatchObject({ events: [] });
    expect(useRunLifecycleStore.getState().activeStreams["chat-1"]?.runId).toBe("run-new");
  });

  it("rejects a malformed outcome before updating client state", async () => {
    const malformed = runResponse();
    malformed.run.status = "preparing" as "complete";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(malformed), {
          headers: {
            "content-type": "application/json"
          },
          status: 200
        })
      )
    );
    const { actions, notice, surface } = useRunLifecycleActionsForTest();

    await expect(actions.fetchRun("run-1", "chat-1")).resolves.toBeNull();

    expect(surface("chat-1")).toMatchObject({ events: [] });
    expect(notice()).toEqual({
      kind: "error",
      text: "Run response was malformed (run_malformed)"
    });
  });

  it("settles a delayed partial upload only in its source composer session", async () => {
    let resolveFirst!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce(
        Response.json({
          attachment: {
            fileName: "second.exe",
            id: "attachment-2",
            kind: "executable"
          }
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    const { actions, composerSession, notice, surface } = useRunLifecycleActionsForTest();

    const upload = actions.uploadFiles([
      new File(["one"], "first.pdf", { type: "application/pdf" }),
      new File(["two"], "second.pdf", { type: "application/pdf" })
    ] as unknown as FileList);
    expect(composerSession("chat-1").pendingUploadGenerations).toHaveLength(1);

    useComposerSessionStore.getState().activateSession(composerSessionKey("chat-2"));
    useComposerSessionStore.getState().setDraft("Draft B");
    resolveFirst(
      Response.json({
        attachment: {
          fileName: "first.pdf",
          id: "attachment-1",
          kind: "pdf"
        }
      })
    );
    await upload;

    expect(composerSession("chat-1").attachments).toEqual([
      {
        fileName: "first.pdf",
        id: "attachment-1",
        kind: "pdf"
      }
    ]);
    expect(composerSession("chat-1")).toMatchObject({
      operationError: expect.stringContaining("upload_malformed"),
      pendingUploadGenerations: []
    });
    expect(composerSession("chat-2")).toMatchObject({
      attachments: [],
      draft: "Draft B",
      operationError: null,
      pendingUploadGenerations: []
    });
    expect(notice()).toBeNull();
    expect(surface("chat-1").events).toEqual([]);
  });

  it("polls processing attachments into their source session after navigation", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({
        attachment: {
          extractedText: null,
          fileName: "report.docx",
          id: "attachment-1",
          kind: "document",
          status: "processing"
        }
      }))
      .mockResolvedValueOnce(Response.json({
        attachment: {
          extractedText: "Parsed report",
          fileName: "report.docx",
          id: "attachment-1",
          kind: "document",
          processingErrorCode: null,
          status: "ready"
        }
      }));
    vi.stubGlobal("fetch", fetchMock);
    const { actions, composerSession } = useRunLifecycleActionsForTest();

    await actions.uploadFiles([
      new File(["docx"], "report.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      })
    ]);
    expect(composerSession("chat-1").attachments).toEqual([
      expect.objectContaining({ id: "attachment-1", status: "processing" })
    ]);
    useComposerSessionStore.getState().activateSession(composerSessionKey("chat-2"));
    useComposerSessionStore.getState().setDraft("Other chat draft");

    await vi.advanceTimersByTimeAsync(500);

    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/uploads/attachment-1");
    expect(composerSession("chat-1").attachments).toEqual([
      expect.objectContaining({
        extractedText: "Parsed report",
        id: "attachment-1",
        status: "ready"
      })
    ]);
    expect(composerSession("chat-2")).toMatchObject({
      attachments: [],
      draft: "Other chat draft"
    });
  });

  it("fails a missing polled attachment and allows send after removal", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({
        attachment: {
          extractedText: null,
          fileName: "missing.docx",
          id: "attachment-1",
          kind: "document",
          status: "processing"
        }
      }))
      .mockResolvedValueOnce(
        Response.json({ error: "attachment_not_found" }, { status: 404 })
      );
    vi.stubGlobal("fetch", fetchMock);
    const { actions, composerSession } = useRunLifecycleActionsForTest();
    useComposerSessionStore.getState().setDraft("Question");

    await actions.uploadFiles([
      new File(["docx"], "missing.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      })
    ]);
    await vi.advanceTimersByTimeAsync(500);

    expect(composerSession("chat-1")).toMatchObject({
      attachments: [{
        fileName: "missing.docx",
        id: "attachment-1",
        kind: "document",
        processingErrorCode: "attachment_unavailable",
        status: "failed"
      }],
      operationError: "missing.docx: attachment is no longer available."
    });
    expect(
      useComposerSessionStore.getState().beginSend(composerSessionKey("chat-1"))
    ).toBeNull();

    await actions.retryAttachment("attachment-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    useComposerSessionStore.getState().setAttachments([]);
    expect(
      useComposerSessionStore.getState().beginSend(composerSessionKey("chat-1"))
    ).toMatchObject({ draft: "Question" });
  });

  it("turns poll-horizon expiry into a retryable status check", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T00:00:00.000Z"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({
        attachment: {
          extractedText: null,
          fileName: "slow.docx",
          id: "attachment-1",
          kind: "document",
          status: "processing"
        }
      }))
      .mockResolvedValueOnce(Response.json({
        attachment: {
          extractedText: null,
          fileName: "slow.docx",
          id: "attachment-1",
          kind: "document",
          status: "processing"
        }
      }))
      .mockResolvedValueOnce(Response.json({
        attachment: {
          extractedText: "Eventually ready",
          fileName: "slow.docx",
          id: "attachment-1",
          kind: "document",
          processingErrorCode: null,
          status: "ready"
        }
      }));
    vi.stubGlobal("fetch", fetchMock);
    const { actions, composerSession } = useRunLifecycleActionsForTest();

    await actions.uploadFiles([
      new File(["docx"], "slow.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      })
    ]);
    vi.setSystemTime(new Date("2026-08-08T00:15:00.000Z"));
    await vi.advanceTimersByTimeAsync(500);

    expect(composerSession("chat-1").attachments).toEqual([
      expect.objectContaining({
        id: "attachment-1",
        processingErrorCode: "attachment_poll_timeout",
        status: "failed"
      })
    ]);

    await actions.retryAttachment("attachment-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(composerSession("chat-1").attachments).toEqual([
      expect.objectContaining({
        id: "attachment-1",
        processingErrorCode: null,
        status: "processing"
      })
    ]);

    await vi.advanceTimersByTimeAsync(500);

    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/uploads/attachment-1");
    expect(composerSession("chat-1").attachments).toEqual([
      expect.objectContaining({
        extractedText: "Eventually ready",
        id: "attachment-1",
        status: "ready"
      })
    ]);
  });

  it("keeps polling after a malformed successful status response", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({
        attachment: {
          extractedText: null,
          fileName: "report.docx",
          id: "attachment-1",
          kind: "document",
          status: "processing"
        }
      }))
      .mockResolvedValueOnce(
        new Response("not-json", {
          headers: { "content-type": "application/json" },
          status: 200
        })
      )
      .mockResolvedValueOnce(Response.json({
        attachment: {
          extractedText: "Parsed after transient failure",
          fileName: "report.docx",
          id: "attachment-1",
          kind: "document",
          processingErrorCode: null,
          status: "ready"
        }
      }));
    vi.stubGlobal("fetch", fetchMock);
    const { actions, composerSession } = useRunLifecycleActionsForTest();

    await actions.uploadFiles([
      new File(["docx"], "report.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      })
    ]);

    await vi.advanceTimersByTimeAsync(500);
    expect(composerSession("chat-1").attachments).toEqual([
      expect.objectContaining({ id: "attachment-1", status: "processing" })
    ]);

    await vi.advanceTimersByTimeAsync(750);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(composerSession("chat-1").attachments).toEqual([
      expect.objectContaining({
        extractedText: "Parsed after transient failure",
        id: "attachment-1",
        status: "ready"
      })
    ]);
  });

  it("retries a failed attachment and resumes lifecycle polling", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({
        attachment: {
          extractedText: null,
          fileName: "report.docx",
          id: "attachment-1",
          kind: "document",
          processingErrorCode: null,
          status: "processing"
        }
      }))
      .mockResolvedValueOnce(Response.json({
        attachment: {
          extractedText: "Ready on retry",
          fileName: "report.docx",
          id: "attachment-1",
          kind: "document",
          processingErrorCode: null,
          status: "ready"
        }
      }));
    vi.stubGlobal("fetch", fetchMock);
    const { actions, composerSession } = useRunLifecycleActionsForTest();
    useComposerSessionStore.getState().setAttachments([{
      fileName: "report.docx",
      id: "attachment-1",
      kind: "document",
      processingErrorCode: "parser_unavailable",
      status: "failed"
    }]);

    await actions.retryAttachment("attachment-1");
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/uploads/attachment-1", {
      method: "POST"
    });
    expect(composerSession("chat-1").attachments).toEqual([
      expect.objectContaining({ id: "attachment-1", status: "processing" })
    ]);

    await vi.advanceTimersByTimeAsync(500);

    expect(composerSession("chat-1").attachments).toEqual([
      expect.objectContaining({ extractedText: "Ready on retry", status: "ready" })
    ]);
  });

  it("continues a multi-file batch after a failed first file", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("too large", { status: 413 }))
      .mockResolvedValueOnce(
        Response.json({
          attachment: {
            fileName: "good.pdf",
            id: "attachment-good",
            kind: "pdf"
          }
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    const { actions, composerSession } = useRunLifecycleActionsForTest();

    const upload = actions.uploadFiles([
      new File(["bad"], "bad.pdf", { type: "application/pdf" }),
      new File(["good"], "good.pdf", { type: "application/pdf" })
    ]);
    useComposerSessionStore.getState().updateSession(composerSessionKey("chat-1"), {
      operationError: "Selected model rejected omitted.exe."
    });
    await upload;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(composerSession("chat-1")).toMatchObject({
      attachments: [{ fileName: "good.pdf", id: "attachment-good", kind: "pdf" }],
      operationError: expect.stringContaining("bad.pdf")
    });
    expect(composerSession("chat-1").operationError).toContain("configured upload size limit");
    expect(composerSession("chat-1").operationError).toContain("omitted.exe");
  });

  it("shows a specific retryable message when upload capacity is busy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: "upload_busy" },
          { headers: { "retry-after": "1" }, status: 429 }
        )
      )
    );
    const { actions, composerSession } = useRunLifecycleActionsForTest();

    await actions.uploadFiles([
      new File(["busy"], "busy.pdf", { type: "application/pdf" })
    ]);

    expect(composerSession("chat-1")).toMatchObject({
      attachments: [],
      operationError: expect.stringContaining("Upload capacity is busy. Try again shortly."),
      pendingUploadGenerations: []
    });
  });

  it.each([
    {
      body: { error: "pdf_password_required", message: "safe server message" },
      expected: "Password-protected PDFs are not supported."
    },
    {
      body: { error: "pdf_invalid", message: "safe server message" },
      expected: "This PDF is damaged or invalid."
    },
    {
      body: { error: "pdf_extraction_timeout", message: "safe server message" },
      expected: "PDF processing timed out."
    },
    {
      body: {
        error: "pdf_page_limit_exceeded",
        maxPages: 500,
        message: "safe server message"
      },
      expected: "This PDF has more than 500 pages."
    },
    {
      body: { error: "pdf_extraction_failed", message: "safe server message" },
      expected: "PDF processing failed. Try another PDF."
    }
  ])("shows a file-specific safe message for $body.error", async ({ body, expected }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(body, { status: 400 }))
    );
    const { actions, composerSession } = useRunLifecycleActionsForTest();

    await actions.uploadFiles([
      new File(["problem"], "problem.pdf", { type: "application/pdf" })
    ]);

    expect(composerSession("chat-1")).toMatchObject({
      attachments: [],
      operationError: `problem.pdf: ${expected}`,
      pendingUploadGenerations: []
    });
  });

  it("keeps mixed-selection rejection feedback after a successful upload settles", async () => {
    let resolveUpload!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveUpload = resolve;
          })
      )
    );
    const { actions, composerSession } = useRunLifecycleActionsForTest();

    const upload = actions.uploadFiles([
      new File(["good"], "good.pdf", { type: "application/pdf" })
    ]);
    useComposerSessionStore.getState().updateSession(composerSessionKey("chat-1"), {
      operationError: "Selected model rejected omitted.exe."
    });
    resolveUpload(
      Response.json({
        attachment: { fileName: "good.pdf", id: "attachment-good", kind: "pdf" }
      })
    );
    await upload;

    expect(composerSession("chat-1")).toMatchObject({
      attachments: [{ fileName: "good.pdf", id: "attachment-good", kind: "pdf" }],
      operationError: expect.stringContaining("omitted.exe"),
      pendingUploadGenerations: []
    });
  });

  it("clears feedback from an older selection when a later all-valid batch starts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          attachment: { fileName: "good.pdf", id: "attachment-good", kind: "pdf" }
        })
      )
    );
    const { actions, composerSession } = useRunLifecycleActionsForTest();
    useComposerSessionStore.getState().updateSession(composerSessionKey("chat-1"), {
      operationError: "Older selection rejected stale.exe."
    });

    await actions.uploadFiles([
      new File(["good"], "good.pdf", { type: "application/pdf" })
    ]);

    expect(composerSession("chat-1")).toMatchObject({
      operationError: null,
      pendingUploadGenerations: []
    });
  });

  it("tracks overlapping source uploads until each settles and discards deleted sources", async () => {
    const resolvers: Array<(response: Response) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolvers.push(resolve);
          })
      )
    );
    const { actions, composerSession } = useRunLifecycleActionsForTest();
    const first = actions.uploadFiles([
      new File(["one"], "first.pdf", { type: "application/pdf" })
    ] as unknown as FileList);
    const second = actions.uploadFiles([
      new File(["two"], "second.pdf", { type: "application/pdf" })
    ] as unknown as FileList);

    expect(composerSession("chat-1").pendingUploadGenerations).toHaveLength(2);
    resolvers[1]!(new Response("newest failed", { status: 500 }));
    await second;
    expect(composerSession("chat-1")).toMatchObject({
      operationError: expect.stringContaining("upload_failed_500"),
      pendingUploadGenerations: expect.any(Array)
    });
    expect(composerSession("chat-1").pendingUploadGenerations).toHaveLength(1);

    resolvers[0]!(
      Response.json({
        attachment: {
          fileName: "first.pdf",
          id: "attachment-1",
          kind: "pdf"
        }
      })
    );
    await first;
    expect(composerSession("chat-1")).toMatchObject({
      attachments: [{ fileName: "first.pdf", id: "attachment-1", kind: "pdf" }],
      operationError: expect.stringContaining("upload_failed_500"),
      pendingUploadGenerations: []
    });

    const late = actions.uploadFiles([
      new File(["late"], "late.pdf", { type: "application/pdf" })
    ] as unknown as FileList);
    useComposerSessionStore.getState().removeSession(composerSessionKey("chat-1"));
    resolvers[2]!(
      Response.json({
        attachment: { fileName: "late.pdf", id: "attachment-late", kind: "pdf" }
      })
    );
    await late;
    expect(composerSession("chat-1")).toMatchObject({ attachments: [], draft: "" });
  });

  it("applies a proven cancellation only to its source stream", async () => {
    const {
      actions,
      activeChatIdRef,
      activeStreamAbortRef,
      refreshActiveChat,
      surface
    } = useRunLifecycleActionsForTest();
    useRunLifecycleStore.getState().streamStarted({
      assistantMessageId: "assistant-1",
      chatId: "chat-1",
      runId: "run-1"
    });
    const controller = new AbortController();
    activeStreamAbortRef.current.set("chat-1", controller);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            run: {
              id: "run-1",
              status: "cancelled"
            }
          })
        )
        .mockResolvedValueOnce(Response.json(runResponse("cancelled")))
    );
    useRunSurfaceStore.getState().appendEvent("chat-2", {
      data: { runId: "run-2" },
      type: "start"
    });
    activeChatIdRef.current = "chat-2";

    await actions.stopCurrentRun();

    expect(controller.signal.aborted).toBe(true);
    expect(surface("chat-1").events).toEqual([{
      data: { runId: "run-1", status: "cancelled" },
      type: "done"
    }]);
    expect(surface("chat-2").events).toEqual([
      { data: { runId: "run-2" }, type: "start" }
    ]);
    expect(useThreadStore.getState().threadsByChatId["chat-1"]?.messages[1]).toMatchObject({
      content: "Stopped.",
      status: "cancelled"
    });
    expect(useRunLifecycleStore.getState().cancelledRunIds.has("run-1")).toBe(true);
    expect(useRunLifecycleStore.getState().activeStreams["chat-1"]).toBeUndefined();
    expect(refreshActiveChat).not.toHaveBeenCalled();
  });

  it("restores the durable completed state when cancellation loses", async () => {
    const {
      actions,
      activeStreamAbortRef,
      notice,
      refreshActiveChat,
      surface
    } = useRunLifecycleActionsForTest();
    useRunLifecycleStore.getState().streamStarted({
      assistantMessageId: "assistant-1",
      chatId: "chat-1",
      runId: "run-1"
    });
    const controller = new AbortController();
    activeStreamAbortRef.current.set("chat-1", controller);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(
            {
              error: "model_run_not_cancelable",
              run: {
                id: "run-1",
                status: "complete"
              }
            },
            { status: 409 }
          )
        )
        .mockResolvedValueOnce(Response.json(runResponse("complete")))
    );

    await actions.stopCurrentRun();

    expect(controller.signal.aborted).toBe(false);
    expect(surface("chat-1")).toMatchObject({ events: [] });
    expect(useThreadStore.getState().threadsByChatId["chat-1"]?.messages[1]).toMatchObject({
      content: "",
      status: "streaming"
    });
    expect(useRunLifecycleStore.getState().cancelledRunIds.has("run-1")).toBe(false);
    expect(useRunLifecycleStore.getState().activeStreams["chat-1"]).toBeUndefined();
    expect(notice()).toBeNull();
    expect(refreshActiveChat).toHaveBeenCalledWith("chat-1", {
      preserveControls: true,
      resumeRuns: false
    });
  });

  it("fails closed on a malformed cancellation response and fetches durable state", async () => {
    const { actions, activeStreamAbortRef, notice, surface } = useRunLifecycleActionsForTest();
    useRunLifecycleStore.getState().streamStarted({
      assistantMessageId: "assistant-1",
      chatId: "chat-1",
      runId: "run-1"
    });
    const controller = new AbortController();
    activeStreamAbortRef.current.set("chat-1", controller);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            run: {
              id: "run-1",
              status: "complete"
            }
          })
        )
        .mockResolvedValueOnce(Response.json(runResponse("complete")))
    );

    await actions.stopCurrentRun();

    expect(controller.signal.aborted).toBe(false);
    expect(surface("chat-1")).toMatchObject({ events: [] });
    expect(useRunLifecycleStore.getState().cancelledRunIds.has("run-1")).toBe(false);
    expect(useRunLifecycleStore.getState().activeStreams["chat-1"]).toMatchObject({
      runId: "run-1"
    });
    expect(notice()).toEqual({
      kind: "error",
      text: "cancel malformed (cancel_malformed)"
    });
  });

  it("keeps the producer active when a losing response still reports an active run", async () => {
    const { actions, activeStreamAbortRef, surface } = useRunLifecycleActionsForTest();
    useRunLifecycleStore.getState().streamStarted({
      assistantMessageId: "assistant-1",
      chatId: "chat-1",
      runId: "run-1"
    });
    const controller = new AbortController();
    activeStreamAbortRef.current.set("chat-1", controller);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(
            {
              error: "model_run_not_cancelable",
              run: {
                id: "run-1",
                status: "streaming"
              }
            },
            { status: 409 }
          )
        )
        .mockResolvedValueOnce(Response.json(runResponse("streaming")))
    );

    await actions.stopCurrentRun();

    expect(controller.signal.aborted).toBe(false);
    expect(surface("chat-1")).toMatchObject({ events: [] });
    expect(useRunLifecycleStore.getState().activeStreams["chat-1"]).toMatchObject({
      runId: "run-1"
    });
    expect(useRunLifecycleStore.getState().cancelledRunIds.has("run-1")).toBe(false);
  });
});
