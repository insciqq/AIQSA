import { afterEach, expect, it, vi } from "vitest";
import { createChatSearchPreferences, updateLocalChatSearch } from "./chatSearchPreferences";
import { useWorkspaceStore } from "./workspaceStore";
import { resetWorkspaceStoreForTest } from "@/tests/support/appShellStores";

const off = { mode: "all_selected" as const, optionIds: [] };
const selected = { mode: "model_choice" as const, optionIds: ["source"] };
const chat = (id: string, updatedAt = "2026-09-23T00:00:00.000Z") => ({
  id, title: "Synthetic chat", activeLeafMessageId: null, createdAt: "2026-09-23T00:00:00.000Z",
  updatedAt, defaultProvider: "fake", defaultModelId: "fake",
  folderId: null, messageCount: 0, pinned: false
});
const response = (id: string, updatedAt?: string) => Response.json({ chat: chat(id, updatedAt) });
afterEach(() => { vi.unstubAllGlobals(); resetWorkspaceStoreForTest(); });

it("reconciles the latest save after a stale read without rolling back a queued choice", async () => {
  let first!: (value: Response) => void, second!: (value: Response) => void;
  const fetch = vi.fn().mockReturnValueOnce(new Promise<Response>(resolve => { first = resolve; }))
    .mockReturnValueOnce(new Promise<Response>(resolve => { second = resolve; }));
  vi.stubGlobal("fetch", fetch);
  useWorkspaceStore.setState({ chats: [chat("a")] });
  const writer = createChatSearchPreferences({ isCurrent: () => true, onError: vi.fn() });
  updateLocalChatSearch("a", off);
  const one = writer.save("a", off);
  updateLocalChatSearch("a", selected);
  const two = writer.save("a", selected);
  first(response("a", "2026-09-23T00:00:01.000Z"));
  await one;
  expect(useWorkspaceStore.getState().chats[0]?.defaultSearchPlan).toEqual(selected);

  useWorkspaceStore.setState({ chats: [{ ...chat("a"), defaultSearchPlan: off }] });
  second(response("a", "2026-09-23T00:00:02.000Z"));
  await two;
  expect(useWorkspaceStore.getState().chats[0]).toMatchObject({
    defaultSearchPlan: selected, updatedAt: "2026-09-23T00:00:02.000Z"
  });
});

it.each(["newer revision", "expired session"])("ignores a save acknowledgement after a %s", async (reason) => {
  const current = { ...chat("a", "2026-09-23T00:00:02.000Z"), defaultSearchPlan: selected };
  useWorkspaceStore.setState({ chats: [current] });
  let finish!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise<Response>(resolve => { finish = resolve; })));
  let active = true;
  const writer = createChatSearchPreferences({ isCurrent: () => active, onError: vi.fn() });
  const saving = writer.save("a", off);
  await Promise.resolve();
  active = reason !== "expired session";
  finish(response("a", reason === "expired session" ? "2026-09-23T00:00:03.000Z" : "2026-09-23T00:00:01.000Z"));
  await saving;
  expect(useWorkspaceStore.getState().chats[0]).toBe(current);
});

it("serializes rapid changes in one chat while another chat can save independently", async () => {
  let finish!: (value: Response) => void;
  const first = new Promise<Response>(resolve => { finish = resolve; });
  const fetch = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(response("b")).mockResolvedValueOnce(response("a"));
  vi.stubGlobal("fetch", fetch);
  const onError = vi.fn();
  const writer = createChatSearchPreferences({ isCurrent: () => true, onError });
  const one = writer.save("a", off), two = writer.save("a", selected), other = writer.save("b", selected);
  await other;
  expect(fetch).toHaveBeenCalledTimes(2);
  finish(response("a"));
  await Promise.all([one, two]);
  expect(fetch.mock.calls.map(([url, options]) => [url, JSON.parse(options.body)])).toEqual([
    ["/api/chats/a", { defaultSearchPlan: off }], ["/api/chats/b", { defaultSearchPlan: selected }],
    ["/api/chats/a", { defaultSearchPlan: selected }]
  ]);
  expect(onError).not.toHaveBeenCalled();
});

it("reports malformed or mismatched responses and still saves the next change", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response("other")).mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(response("a"));
  vi.stubGlobal("fetch", fetch);
  const onError = vi.fn();
  const writer = createChatSearchPreferences({ isCurrent: () => true, onError });
  await Promise.all([writer.save("a", off), writer.save("a", selected), writer.save("a", off)]);
  expect(onError).toHaveBeenCalledTimes(2);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("discards pending saves and late errors after an account changes", async () => {
  let fail!: (error: Error) => void;
  const first = new Promise<Response>((_resolve, reject) => { fail = reject; });
  const fetch = vi.fn().mockReturnValue(first);
  vi.stubGlobal("fetch", fetch);
  let current = true;
  const onError = vi.fn();
  const writer = createChatSearchPreferences({ isCurrent: () => current, onError });
  const one = writer.save("a", off), two = writer.save("a", selected);
  await Promise.resolve();
  expect(fetch).toHaveBeenCalledOnce();
  current = false;
  fail(new Error("offline"));
  await Promise.all([one, two]);
  expect(fetch).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
});
