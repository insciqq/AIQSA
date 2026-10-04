import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatImportResponse } from "@/lib/contracts/chatImport";
import { ChatImportRowV2 } from "./ChatImportRowV2";
import { dismissChatImport, startChatImport } from "./chatImportClient";
import type { ChatImportRunnerDeps } from "./chatImportRunner";
import type { ImportBatch } from "./importPipeline";
import type { ImportWorkerPort, ImportWorkerResponse } from "./importWorkerProtocol";

function scriptedDeps(steps: readonly ImportBatch[], send: ChatImportRunnerDeps["sendBatch"]): ChatImportRunnerDeps {
  return {
    createWorker(): ImportWorkerPort {
      let index = 0;
      const port: ImportWorkerPort = {
        onerror: null,
        onmessage: null,
        postMessage() {
          const step = steps[index++];
          if (step) queueMicrotask(() => port.onmessage?.({ data: { batch: step, type: "batch" } } as MessageEvent<ImportWorkerResponse>));
        },
        terminate() {}
      };
      return port;
    },
    sendBatch: send
  };
}

const step = (overrides: Partial<ImportBatch>): ImportBatch => ({
  body: null, done: false, failed: [], sent: [], skipped: {}, totalDelta: 0, ...overrides
});

afterEach(() => {
  dismissChatImport();
  cleanup();
});

describe("ChatImportRowV2", () => {
  it("offers the import with the accepted export files", () => {
    render(<ChatImportRowV2 />);
    expect(screen.getByText("Import chats")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import…" })).toBeEnabled();
    const input = screen.getByTestId("settings-import-input");
    expect(input).toHaveAttribute("accept", expect.stringContaining(".tgz"));
    expect(input).toHaveAttribute("multiple");
  });

  it("shows progress by chats and then the report with skipped content and failures", async () => {
    let release!: (response: ChatImportResponse) => void;
    const onImported = vi.fn();
    render(<ChatImportRowV2 />);
    act(() => {
      startChatImport([new File(["x"], "aiqsa-chats.tar.gz")], {
        deps: scriptedDeps([
          step({
            body: "{\"chats\":[]}",
            failed: [{ reason: "too_large", title: "Huge chat" }, { file: true, reason: "unsupported_file", title: "notes.txt" }],
            sent: [{ messages: 3, title: "One" }, { messages: 5, title: "Two" }],
            skipped: { attachment: 2, empty_chat: 1 },
            totalDelta: 4
          }),
          step({ done: true })
        ], () => new Promise((resolve) => { release = resolve; })),
        onImported
      });
    });
    // The unreadable file is no chat: only the too-large chat and the empty one count.
    expect(await screen.findByText("Importing chats: 2 of 4")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Chats processed" })).toHaveAttribute("aria-valuenow", "2");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    await act(async () => {
      release({ results: [{ messages: 3, status: "imported" }, { status: "already_imported" }] });
    });
    const report = await screen.findByTestId("chat-import-report");
    expect(report).toHaveTextContent("Import finished");
    expect(report).toHaveTextContent("Imported 1 chat (3 messages).");
    expect(report).toHaveTextContent("1 chat already imported.");
    expect(report).toHaveTextContent("Not imported, marked in the messages: 2 attachments, 1 empty chat.");
    expect(report).toHaveTextContent("Couldn't import 1 chat and 1 file:");
    expect(screen.getByTestId("chat-import-failed")).toHaveTextContent("Huge chat — Too large to import (over 8 MB)");
    expect(screen.getByTestId("chat-import-failed")).toHaveTextContent("notes.txt — Not a supported export file");
    expect(onImported).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByTestId("chat-import-report")).not.toBeInTheDocument();
  });

  it("cancels: the chats being saved finish and the report says what stays", async () => {
    let release!: (response: ChatImportResponse) => void;
    render(<ChatImportRowV2 />);
    act(() => {
      startChatImport([new File(["x"], "a.json")], {
        deps: scriptedDeps([
          step({ body: "{\"chats\":[]}", sent: [{ messages: 2, title: "Saved" }], totalDelta: 3 }),
          step({ done: true })
        ], () => new Promise((resolve) => { release = resolve; }))
      });
    });
    await screen.findByText("Importing chats: 0 of 3");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Stopping after the chats being saved now…")).toBeInTheDocument();
    await act(async () => {
      release({ results: [{ messages: 2, status: "imported" }] });
    });
    const report = await screen.findByTestId("chat-import-report");
    expect(report).toHaveTextContent("Import cancelled");
    expect(report).toHaveTextContent("Imported 1 chat (2 messages).");
    expect(report).toHaveTextContent("Chats imported before you cancelled stay.");
  });
});
