import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { ChatSearchEmbedder } from "../chatSearch/embedder";
import { CHAT_SEARCH_BACKFILL_PASS_INTERVAL_MS } from "../chatSearch/index/backfill";
import { CHAT_SEARCH_INDEX_PASS_INTERVAL_MS } from "../chatSearch/index/pass";
import {
  CHAT_SEARCH_BACKFILL_PASS_NAME,
  CHAT_SEARCH_INDEX_PASS_NAME,
  createChatSearchBackfillPass,
  createChatSearchIndexPass
} from "./chatSearchPasses";
import { assertBackgroundPass, BackgroundPassRegistry } from "./passes";

const db = {} as PrismaClient;
const embedder = { currentModel: vi.fn(), embed: vi.fn() } as unknown as ChatSearchEmbedder;
const summary = (more: boolean) => ({ cleared: 0, claimed: 1, embedded: 0, failed: 0, gone: 0, indexed: 1,
  model: "not_checked" as const, more, stale: 0 });

describe("the past-chat search passes of the background worker", () => {
  it("are valid passes on the indexer's cadences, and register beside each other", () => {
    const index = createChatSearchIndexPass({ db, embedder });
    const backfill = createChatSearchBackfillPass({ db, embedder });

    expect(assertBackgroundPass(index)).toMatchObject({
      intervalMs: CHAT_SEARCH_INDEX_PASS_INTERVAL_MS, name: CHAT_SEARCH_INDEX_PASS_NAME
    });
    expect(assertBackgroundPass(backfill)).toMatchObject({
      intervalMs: CHAT_SEARCH_BACKFILL_PASS_INTERVAL_MS, name: CHAT_SEARCH_BACKFILL_PASS_NAME
    });
    const registry = new BackgroundPassRegistry();
    registry.register(index);
    registry.register(backfill);
    expect(registry.list().map(({ name }) => name)).toEqual([CHAT_SEARCH_INDEX_PASS_NAME, CHAT_SEARCH_BACKFILL_PASS_NAME]);
  });

  it("runs the index pass with the worker's clock and signal, and asks again at once while work is due", async () => {
    const runIndexPass = vi.fn(async () => summary(true));
    const pass = createChatSearchIndexPass({ db, embedder, runIndexPass });
    const now = () => new Date("2026-11-22T12:00:00Z");
    const signal = new AbortController().signal;

    await expect(pass.run({ now, signal })).resolves.toEqual({ more: true });
    expect(runIndexPass).toHaveBeenCalledWith({ db, embedder, now, signal });

    runIndexPass.mockResolvedValueOnce(summary(false));
    await expect(pass.run({ now, signal })).resolves.toEqual({ more: false });
  });

  it("runs the backfill sweep, reports a full batch, and skips it once the worker is stopping", async () => {
    const runBackfillPass = vi.fn(async () => ({ added: 200, leftovers: 0, more: true, vectors: 0 }));
    const pass = createChatSearchBackfillPass({ db, embedder, runBackfillPass });
    const now = () => new Date();

    await expect(pass.run({ now, signal: new AbortController().signal })).resolves.toEqual({ more: true });
    expect(runBackfillPass).toHaveBeenCalledWith({ db, embedder });

    const stopping = new AbortController();
    stopping.abort();
    await expect(pass.run({ now, signal: stopping.signal })).resolves.toEqual({});
    expect(runBackfillPass).toHaveBeenCalledOnce();
  });

  it("lets a failing pass throw, so the worker backs it off and logs only its code", async () => {
    const failure = new Error("chat_search_index_failed");
    const pass = createChatSearchIndexPass({ db, embedder, runIndexPass: vi.fn(async () => { throw failure; }) });

    await expect(pass.run({ now: () => new Date(), signal: new AbortController().signal })).rejects.toBe(failure);
  });
});
