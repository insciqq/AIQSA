import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  composerDraftEpochKey,
  createInitialComposerDraftEpoch,
  signOutComposerDraftEpoch
} from "@/components/app-shell/composerDraftStorage";
import type { ChatImportResponse } from "@/lib/contracts/chatImport";
import { ChatImportRowV2 } from "./ChatImportRowV2";
import { dismissChatImport, startChatImport } from "./chatImportClient";
import type { ChatImportRunnerDeps } from "./chatImportRunner";
import type { ImportBatch } from "./importPipeline";
import type { ImportWorkerPort, ImportWorkerResponse } from "./importWorkerProtocol";

const accountId = "account-1";

function scriptedDeps(
  steps: readonly ImportBatch[],
  send: ChatImportRunnerDeps["sendBatch"],
  workers: Array<{ terminated: boolean }> = []
): ChatImportRunnerDeps {
  return {
    createWorker(): ImportWorkerPort {
      let index = 0;
      const record = { terminated: false };
      workers.push(record);
      const port: ImportWorkerPort = {
        onerror: null,
        onmessage: null,
        postMessage() {
          const step = steps[index++];
          if (step) queueMicrotask(() => port.onmessage?.({ data: { batch: step, type: "batch" } } as MessageEvent<ImportWorkerResponse>));
        },
        terminate() {
          record.terminated = true;
        }
      };
      return port;
    },
    sendBatch: send
  };
}

const step = (overrides: Partial<ImportBatch>): ImportBatch => ({
  body: null, done: false, failed: [], sent: [], skipped: {}, totalDelta: 0, ...overrides
});

/** Another tab signs this account out: the logout fence moves and this tab hears of it. */
function signOutInAnotherTab(): void {
  signOutComposerDraftEpoch(accountId);
  window.dispatchEvent(new StorageEvent("storage", { key: composerDraftEpochKey(accountId) }));
}

afterEach(() => {
  dismissChatImport();
  cleanup();
  window.localStorage.clear();
});

describe("ChatImportRowV2", () => {
  it("offers the import with the accepted export files", () => {
    render(<ChatImportRowV2 accountId={accountId} />);
    expect(screen.getByText("Import chats")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import…" })).toBeEnabled();
    const input = screen.getByTestId("settings-import-input");
    expect(input).toHaveAttribute("accept", expect.stringContaining(".tgz"));
    expect(input).toHaveAttribute("multiple");
  });

  it("shows progress by chats and then the report with skipped content and failures", async () => {
    let release!: (response: ChatImportResponse) => void;
    const onImported = vi.fn();
    render(<ChatImportRowV2 accountId={accountId} />);
    act(() => {
      startChatImport([new File(["x"], "aiqsa-chats.tar.gz")], {
        accountId,
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
    render(<ChatImportRowV2 accountId={accountId} />);
    act(() => {
      startChatImport([new File(["x"], "a.json")], {
        accountId,
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

  it("stops a running import when its account signs out in another tab and drops its details", async () => {
    createInitialComposerDraftEpoch(accountId);
    const workers: Array<{ terminated: boolean }> = [];
    let signal: AbortSignal | null = null;
    render(<ChatImportRowV2 accountId={accountId} />);
    act(() => {
      startChatImport([new File(["x"], "a.json")], {
        accountId,
        deps: scriptedDeps([
          step({ body: "{}", failed: [{ reason: "too_large", title: "Private chat title" }], sent: [{ messages: 2, title: "Sent title" }], totalDelta: 3 }),
          step({ done: true })
        ], (_body, _count, requestSignal) => new Promise((_resolve, reject) => {
          signal = requestSignal;
          requestSignal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }), workers)
      });
    });
    await screen.findByText("Importing chats: 1 of 3");
    act(() => signOutInAnotherTab());
    const report = await screen.findByTestId("chat-import-report");
    expect(report).toHaveTextContent("Import stopped");
    expect(report).toHaveTextContent("You signed out or switched accounts, so the import stopped and its details were cleared.");
    expect(report).not.toHaveTextContent("Private chat title");
    expect(signal!.aborted).toBe(true);
    expect(workers.every((worker) => worker.terminated)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByTestId("chat-import-report")).not.toBeInTheDocument();
  });

  it("clears a finished report on sign-out, and never shows another account's import", async () => {
    createInitialComposerDraftEpoch(accountId);
    const { rerender } = render(<ChatImportRowV2 accountId={accountId} />);
    act(() => {
      startChatImport([new File(["x"], "a.json")], {
        accountId,
        deps: scriptedDeps([step({ done: true, failed: [{ reason: "too_large", title: "Private chat title" }], totalDelta: 1 })], vi.fn())
      });
    });
    expect(await screen.findByTestId("chat-import-failed")).toHaveTextContent("Private chat title");
    rerender(<ChatImportRowV2 accountId="account-2" />);
    expect(screen.queryByTestId("chat-import-report")).not.toBeInTheDocument();
    rerender(<ChatImportRowV2 accountId={accountId} />);
    act(() => signOutInAnotherTab());
    const report = await screen.findByTestId("chat-import-report");
    expect(report).toHaveTextContent("details were cleared");
    expect(report).not.toHaveTextContent("Private chat title");
  });
});
