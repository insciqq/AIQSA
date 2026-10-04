// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ChatExportDocument } from "@/lib/contracts/chatExport";
import { decodeChatImportRequestItems, type ChatImportResponse } from "@/lib/contracts/chatImport";
import { buildTarGz } from "./archive/archive.testFixtures";
import { ChatImportRequestError, runChatImport, type ChatImportRunnerDeps, type ChatImportState } from "./chatImportRunner";
import { createChatImportConverters } from "./converters/registry";
import { openImportFile } from "./importFile";
import { importBatches, type ImportBatch } from "./importPipeline";
import type { ImportWorkerPort, ImportWorkerRequest, ImportWorkerResponse } from "./importWorkerProtocol";

const now = () => new Date("2026-10-05T12:00:00.000Z");

function exportDocument(title: string): ChatExportDocument {
  return {
    format: "aiqsa.chat",
    version: 1,
    exportedAt: "2026-10-01T00:00:00.000Z",
    chat: {
      activeLeafId: "m2",
      archived: false,
      createdAt: "2026-09-01T09:59:00.000Z",
      messages: [
        { createdAt: "2026-09-01T10:00:00.000Z", id: "m1", parentId: null, role: "user", status: "complete", text: `Question ${title}` },
        { createdAt: "2026-09-01T10:01:00.000Z", id: "m2", parentId: "m1", role: "assistant", status: "complete", text: `Answer ${title}` }
      ],
      pinned: false,
      title,
      updatedAt: "2026-09-02T10:00:00.000Z"
    }
  };
}

type TestPort = ImportWorkerPort & { requests: ImportWorkerRequest[]; terminated: boolean };

/** Runs the real pipeline and converters in-process, one step per request. */
function inProcessWorker(): TestPort {
  let steps: AsyncGenerator<ImportBatch> | null = null;
  const port: TestPort = {
    onerror: null,
    onmessage: null,
    postMessage(message) {
      port.requests.push(message);
      void (async () => {
        if (message.type === "start") {
          const files = await Promise.all(message.files.map((file) => openImportFile(file)));
          steps = importBatches(files, { converters: createChatImportConverters(), maxChats: 2, now });
        }
        const next = await steps!.next();
        const data: ImportWorkerResponse = next.done ? { code: "import_failed", type: "error" } : { batch: next.value, type: "batch" };
        port.onmessage?.({ data } as MessageEvent<ImportWorkerResponse>);
      })();
    },
    requests: [],
    terminate() {
      port.terminated = true;
    },
    terminated: false
  };
  return port;
}

/** Answers each request with the next scripted response; `null` leaves the request pending. */
function scriptedWorker(responses: ReadonlyArray<ImportWorkerResponse | null>): TestPort {
  let index = 0;
  const port: TestPort = {
    onerror: null,
    onmessage: null,
    postMessage(message) {
      port.requests.push(message);
      const data = responses[index++];
      if (data) queueMicrotask(() => port.onmessage?.({ data } as MessageEvent<ImportWorkerResponse>));
    },
    requests: [],
    terminate() {
      port.terminated = true;
    },
    terminated: false
  };
  return port;
}

const batch = (overrides: Partial<ImportBatch>): ImportWorkerResponse => ({
  batch: { body: null, done: false, failed: [], sent: [], skipped: {}, totalDelta: 0, ...overrides },
  type: "batch"
});

describe("chat import runner", () => {
  it("imports a bulk archive step by step and reports every outcome", async () => {
    const archive = await buildTarGz([
      {
        content: JSON.stringify({
          format: "aiqsa.chat-archive",
          version: 1,
          exportedAt: "2026-10-01T00:00:00.000Z",
          chats: ["a", "b", "c", "d"].map((name) => ({
            archived: false, markdownPath: `${name}.md`, path: `${name}.json`, title: `Chat ${name}`, updatedAt: "2026-09-02T10:00:00.000Z"
          }))
        }),
        path: "manifest.json"
      },
      ...["a", "b", "c"].map((name) => ({ content: JSON.stringify(exportDocument(`Chat ${name}`)), path: `${name}.json` }))
    ]);
    const worker = inProcessWorker();
    const sendBatch = vi.fn<ChatImportRunnerDeps["sendBatch"]>(async (body, count): Promise<ChatImportResponse> => {
      const items = decodeChatImportRequestItems(JSON.parse(body)) as Array<{ document: ChatExportDocument }>;
      expect(items).toHaveLength(count);
      return {
        results: items.map((item) => item.document.chat.title === "Chat b"
          ? { status: "already_imported" as const }
          : { messages: 2, status: "imported" as const })
      };
    });
    const states: ChatImportState[] = [];
    const run = runChatImport([new File([archive], "aiqsa-chats.tar.gz")], { createWorker: () => worker, sendBatch }, (state) => {
      states.push(state);
    });
    const final = await run.finished;
    expect(final).toMatchObject({
      alreadyImported: 1,
      error: null,
      importedChats: 2,
      importedMessages: 4,
      phase: "finished",
      processed: 4,
      total: 4
    });
    expect(final.failed).toEqual([{ reason: "Listed in the archive index but missing from the archive", title: "Chat d" }]);
    expect(sendBatch).toHaveBeenCalledTimes(2);
    expect(states[0]!.phase).toBe("reading");
    expect(states.some((state) => state.phase === "importing")).toBe(true);
    expect(worker.terminated).toBe(true);
  });

  it("cancels while reading without sending anything", async () => {
    const worker = scriptedWorker([null]);
    const sendBatch = vi.fn<ChatImportRunnerDeps["sendBatch"]>();
    const run = runChatImport([new File(["{}"], "a.json")], { createWorker: () => worker, sendBatch }, () => undefined);
    run.cancel();
    expect((await run.finished).phase).toBe("cancelled");
    expect(sendBatch).not.toHaveBeenCalled();
    expect(worker.terminated).toBe(true);
  });

  it("lets the batch being sent finish on cancel and asks for no further step", async () => {
    let release!: (response: ChatImportResponse) => void;
    const worker = scriptedWorker([batch({ body: "{\"chats\":[]}", sent: [{ messages: 3, title: "Kept" }], totalDelta: 2 })]);
    const phases: string[] = [];
    const run = runChatImport([new File(["{}"], "a.json")], {
      createWorker: () => worker,
      sendBatch: () => new Promise((resolve) => { release = resolve; })
    }, (state) => phases.push(state.phase));
    await vi.waitFor(() => expect(phases).toContain("importing"));
    run.cancel();
    expect(phases.at(-1)).toBe("stopping");
    release({ results: [{ messages: 3, status: "imported" }] });
    const final = await run.finished;
    expect(final).toMatchObject({ importedChats: 1, importedMessages: 3, phase: "cancelled", total: 2 });
    expect(worker.requests.map((request) => request.type)).toEqual(["start"]);
  });

  it("stops on a server failure and marks the unconfirmed chats", async () => {
    const worker = scriptedWorker([batch({ body: "{\"chats\":[]}", sent: [{ messages: 2, title: "Lost?" }] })]);
    const run = runChatImport([new File(["{}"], "a.json")], {
      createWorker: () => worker,
      sendBatch: async () => { throw new ChatImportRequestError(503); }
    }, () => undefined);
    const final = await run.finished;
    expect(final.phase).toBe("failed");
    expect(final.error).toMatch(/server did not respond/u);
    expect(final.failed).toEqual([{ reason: "The server did not confirm it; run the import again to check", title: "Lost?" }]);
    expect(worker.terminated).toBe(true);
  });

  it("reports a worker that cannot read the files or crashes", async () => {
    const unreadable = runChatImport([new File(["{}"], "a.json")], {
      createWorker: () => scriptedWorker([{ code: "import_files_unreadable", type: "error" }]),
      sendBatch: vi.fn()
    }, () => undefined);
    expect(await unreadable.finished).toMatchObject({ error: "The selected files could not be read. Pick them again.", phase: "failed" });
    const crashing = scriptedWorker([null]);
    const crashed = runChatImport([new File(["{}"], "a.json")], { createWorker: () => crashing, sendBatch: vi.fn() }, () => undefined);
    crashing.onerror?.(new Event("error") as ErrorEvent);
    expect((await crashed.finished).phase).toBe("failed");
  });
});
