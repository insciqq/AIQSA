import type { PrismaClient } from "@prisma/client";
import type { ChatSearchEmbedder } from "../chatSearch/embedder";
import { CHAT_SEARCH_BACKFILL_PASS_INTERVAL_MS, runChatSearchBackfillPass } from "../chatSearch/index/backfill";
import { CHAT_SEARCH_INDEX_PASS_INTERVAL_MS, runChatSearchIndexPass } from "../chatSearch/index/pass";
import type { BackgroundPass } from "./passes";

/**
 * The past-chat search duties of the background worker. Chats are marked dirty in the transactions that change them
 * (`lib/server/chatSearch/index/dirty.ts`); the index pass rewrites a marked chat's passages and embeds them, running
 * again at once while it reports more due work, and the backfill gives unmarked chats their first state and heals
 * missing vectors.
 */
export const CHAT_SEARCH_INDEX_PASS_NAME = "chat_search_index";
export const CHAT_SEARCH_BACKFILL_PASS_NAME = "chat_search_backfill";

export type ChatSearchPassDependencies = Readonly<{
  db: PrismaClient;
  embedder: ChatSearchEmbedder;
  /** Test seams; the defaults are the indexer's own passes. */
  runIndexPass?: typeof runChatSearchIndexPass;
  runBackfillPass?: typeof runChatSearchBackfillPass;
}>;

export function createChatSearchIndexPass(dependencies: ChatSearchPassDependencies): BackgroundPass {
  const run = dependencies.runIndexPass ?? runChatSearchIndexPass;
  return {
    intervalMs: CHAT_SEARCH_INDEX_PASS_INTERVAL_MS,
    name: CHAT_SEARCH_INDEX_PASS_NAME,
    async run({ now, signal }) {
      const summary = await run({ db: dependencies.db, embedder: dependencies.embedder, now, signal });
      return { more: summary.more };
    }
  };
}

export function createChatSearchBackfillPass(dependencies: ChatSearchPassDependencies): BackgroundPass {
  const run = dependencies.runBackfillPass ?? runChatSearchBackfillPass;
  return {
    intervalMs: CHAT_SEARCH_BACKFILL_PASS_INTERVAL_MS,
    name: CHAT_SEARCH_BACKFILL_PASS_NAME,
    async run({ signal }) {
      if (signal.aborted) return {};
      const summary = await run({ db: dependencies.db, embedder: dependencies.embedder });
      return { more: summary.more };
    }
  };
}
