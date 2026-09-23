import { afterEach, expect, it, vi } from "vitest";
import { createChatSearchPreferences } from "./chatSearchPreferences";

const off = { mode: "all_selected" as const, optionIds: [] };
const selected = { mode: "model_choice" as const, optionIds: ["source"] };
const response = (id: string) => Response.json({ chat: {
  id, title: "Synthetic chat", activeLeafMessageId: null, createdAt: "2026-09-23T00:00:00.000Z",
  updatedAt: "2026-09-23T00:00:00.000Z", defaultProvider: "fake", defaultModelId: "fake",
  folderId: null, messageCount: 0, pinned: false
} });
afterEach(() => vi.unstubAllGlobals());

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
