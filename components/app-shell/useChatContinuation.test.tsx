import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChatContinuation } from "./useChatContinuation";
import { ChatContextIndicatorV2 } from "@/features/workspace-v2/ChatContextIndicatorV2";
import type { ChatContinuationModelSelection } from "@/lib/contracts/chatContinuation";

const onOpen = vi.fn();
const updatedAt = "2026-09-05T12:00:00.000Z";
const child = {
  activeLeafMessageId: "summary", createdAt: updatedAt, updatedAt, defaultKnowledgePlan: null,
  defaultModelId: null, defaultProvider: null, folderId: null, id: "new-chat", messageCount: 1, pinned: false,
  projectId: null, title: "Continued: source", hasContinuationSource: true,
  contextStats: { approximateActiveBranchInputTokens: 20 }, usageStats: null,
  pageInfo: { activeLeafMessageId: "summary", beforeCursor: null, hasOlder: false, snapshotUpdatedAt: updatedAt },
  messages: [{ id: "summary", parentMessageId: null, role: "assistant", status: "complete", createdAt: updatedAt,
    content: { blocks: [{ type: "text", text: "Conversation summary" }] }, modelId: null, modelRunId: null,
    provider: null, errorMessage: null, artifactSummary: null, citationMessageId: null }]
};
function Harness({ chatId = "source", leaf = "answer", eligible = true, recommended = true, uploading = false, modelSelection }: {
  chatId?: string; leaf?: string; eligible?: boolean; recommended?: boolean; uploading?: boolean;
  modelSelection?: ChatContinuationModelSelection;
}) {
  const control = useChatContinuation({ accountId: "owner", chatId, leafMessageId: leaf, eligible, recommended, uploading, modelSelection, onOpen });
  return <ChatContextIndicatorV2 continuation={eligible ? control : null} stats={{
    approximateInputTokens: 700, safeInputBudgetTokens: 1000, totalContextTokens: 1500
  }} />;
}

beforeEach(() => {
  // Exercise these actions with the Crypto API exposed on non-loopback HTTP.
  vi.stubGlobal("crypto", { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
});

beforeEach(() => { localStorage.clear(); onOpen.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

it("waits for a completed answer and remembers dismissal across later messages and reloads", async () => {
  const view = render(<Harness eligible={false} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  view.rerender(<Harness />);
  await screen.findByRole("button", { name: "Stay here" });
  fireEvent.click(screen.getByRole("button", { name: "Stay here" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  view.rerender(<Harness leaf="later-answer" />);
  expect(screen.queryByRole("dialog")).toBeNull();
  view.unmount();
  render(<Harness leaf="later-answer" />);
  await act(async () => {});
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByTestId("header-context-indicator"));
  expect(screen.getByRole("dialog")).toBeVisible();
});

it("opens the saved summary after one action and ignores a second click", async () => {
  let finish!: (response: Response) => void;
  const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
    .mockResolvedValueOnce(Response.json({ chat: child }))
    .mockResolvedValueOnce(Response.json({ allowedActions: ["EXCLUDE"], archived: false, mode: "NORMAL", temporaryRetentionDeadline: null }));
  vi.stubGlobal("fetch", fetch);
  render(<Harness />);
  const button = await screen.findByRole("button", { name: "Summarize and open new chat" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(fetch).toHaveBeenCalledOnce();
  expect(screen.getByRole("status")).toHaveTextContent("Preparing your summary");
  await act(async () => { finish(Response.json({ status: "complete", chatId: "new-chat", projectId: null })); });
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "new-chat", hasContinuationSource: true }), "chat:source"));
});

it("stays on failure and uses a fresh request only after a definite failure", async () => {
  const fetch = vi.fn().mockImplementation(async () => Response.json({ error: "chat_summary_failed" }, { status: 502 }));
  vi.stubGlobal("fetch", fetch);
  render(<Harness />);
  fireEvent.click(await screen.findByRole("button", { name: "Summarize and open new chat" }));
  await screen.findByRole("alert");
  expect(onOpen).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Summarize and open new chat" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  const ids = fetch.mock.calls.map(([, options]) => JSON.parse(options.body).requestId);
  expect(ids[0]).not.toBe(ids[1]);
});

it("reuses the same request and model selection after ambiguous network failure", async () => {
  const fetch = vi.fn().mockRejectedValue(new Error("network"));
  vi.stubGlobal("fetch", fetch);
  const selection = { provider: "provider", modelId: "chosen" };
  const view = render(<Harness modelSelection={selection} />);
  fireEvent.click(await screen.findByRole("button", { name: "Summarize and open new chat" }));
  await screen.findByRole("alert");
  view.rerender(<Harness modelSelection={{ provider: "other", modelId: "changed" }} />);
  fireEvent.click(screen.getByRole("button", { name: "Summarize and open new chat" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(JSON.parse(fetch.mock.calls[0]![1].body).requestId).toBe(JSON.parse(fetch.mock.calls[1]![1].body).requestId);
  for (const [, options] of fetch.mock.calls) expect(JSON.parse(options.body).modelSelection).toEqual(selection);
});

it("waits for uploads and keeps cancellation usable if an upload starts during summarization", async () => {
  const fetch = vi.fn().mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal("fetch", fetch);
  const view = render(<Harness uploading />);
  const button = await screen.findByRole("button", { name: "Summarize and open new chat" });
  expect(button).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("Wait for uploads to finish.");
  fireEvent.click(button);
  expect(fetch).not.toHaveBeenCalled();
  view.rerender(<Harness />);
  fireEvent.click(button);
  expect(fetch).toHaveBeenCalledOnce();
  view.rerender(<Harness uploading />);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Stopping the summary");
  expect(onOpen).not.toHaveBeenCalled();
});

it("keeps the source input owner when the saved summary detail cannot be opened", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ status: "complete", chatId: "new-chat", projectId: null }))
    .mockResolvedValueOnce(Response.json({ error: "chat_not_found" }, { status: 404 }));
  vi.stubGlobal("fetch", fetch);
  render(<Harness />);
  fireEvent.click(await screen.findByRole("button", { name: "Summarize and open new chat" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("new chat could not be opened");
  expect(onOpen).not.toHaveBeenCalled();
});

it.each(["navigation", "branch", "cancel"])("never opens a late response after %s", async (action) => {
  let finish!: (response: Response) => void;
  const fetch = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
  vi.stubGlobal("fetch", fetch);
  const view = render(<Harness />);
  fireEvent.click(await screen.findByRole("button", { name: "Summarize and open new chat" }));
  if (action === "cancel") fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  else view.rerender(<Harness chatId={action === "navigation" ? "other" : "source"} leaf="changed" />);
  expect(fetch.mock.calls[0]![1].signal.aborted).toBe(action !== "cancel");
  await act(async () => { finish(Response.json({ status: "complete", chatId: "new-chat", projectId: null })); });
  expect(onOpen).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledOnce();
});

it("keeps a quiet indicator below the warning threshold", async () => {
  render(<Harness recommended={false} />);
  await act(async () => {});
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("shows background progress and sends cancellation only after the claim is acknowledged", async () => {
  let acknowledge!: (response: Response) => void;
  const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { acknowledge = resolve; }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(Response.json({ error: "chat_summary_cancelled" }, { status: 409 }));
  vi.stubGlobal("fetch", fetch);
  const view = render(<Harness />);
  fireEvent.click(await screen.findByRole("button", { name: "Summarize and open new chat" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(fetch).toHaveBeenCalledOnce();
  await act(async () => { acknowledge(Response.json({ status: "running", progress: { completedParts: 9, stage: "combining" } })); });
  expect(screen.getByRole("status")).toHaveTextContent("Combining summaries · 9 parts processed");
  expect(fetch.mock.calls[1]![1].method).toBe("DELETE");
  expect(JSON.parse(fetch.mock.calls[1]![1].body).requestId).toBe(JSON.parse(fetch.mock.calls[0]![1].body).requestId);
  expect(onOpen).not.toHaveBeenCalled();
  view.unmount();
});

it("does not open a completed chat when cancellation arrives while its details load", async () => {
  let finish!: (response: Response) => void;
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ status: "complete", chatId: "new-chat", projectId: null }))
    .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal("fetch", fetch);
  render(<Harness />);
  fireEvent.click(await screen.findByRole("button", { name: "Summarize and open new chat" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await act(async () => { finish(Response.json({ chat: child })); });
  expect(onOpen).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(2);
});
