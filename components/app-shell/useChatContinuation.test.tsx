import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChatContinuation } from "./useChatContinuation";
import { ChatContextIndicatorV2 } from "@/features/workspace-v2/ChatContextIndicatorV2";

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
function Harness({ chatId = "source", leaf = "answer", eligible = true, recommended = true }) {
  const control = useChatContinuation({ accountId: "owner", chatId, leafMessageId: leaf, eligible, recommended, onOpen });
  return <ChatContextIndicatorV2 continuation={eligible ? control : null} stats={{
    approximateInputTokens: 700, safeInputBudgetTokens: 1000, totalContextTokens: 1500
  }} />;
}
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
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "new-chat", hasContinuationSource: true })));
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

it("reuses the same request after ambiguous network failure", async () => {
  const fetch = vi.fn().mockRejectedValue(new Error("network"));
  vi.stubGlobal("fetch", fetch);
  render(<Harness />);
  fireEvent.click(await screen.findByRole("button", { name: "Summarize and open new chat" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Summarize and open new chat" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(JSON.parse(fetch.mock.calls[0]![1].body).requestId).toBe(JSON.parse(fetch.mock.calls[1]![1].body).requestId);
});

it.each(["navigation", "branch", "cancel"])("never opens a late response after %s", async (action) => {
  let finish!: (response: Response) => void;
  const fetch = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
  vi.stubGlobal("fetch", fetch);
  const view = render(<Harness />);
  fireEvent.click(await screen.findByRole("button", { name: "Summarize and open new chat" }));
  if (action === "cancel") fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  else view.rerender(<Harness chatId={action === "navigation" ? "other" : "source"} leaf="changed" />);
  expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true);
  await act(async () => { finish(Response.json({ status: "complete", chatId: "new-chat", projectId: null })); });
  expect(onOpen).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledOnce();
});

it("keeps a quiet indicator below the warning threshold", async () => {
  render(<Harness recommended={false} />);
  await act(async () => {});
  expect(screen.queryByRole("dialog")).toBeNull();
});
