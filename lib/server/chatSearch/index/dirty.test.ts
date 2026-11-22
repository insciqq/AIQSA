import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { clearChatSearch, markChatSearchDirty, markOwnerChatsSearchDirty, scheduleChatSearchReembedding } from "./dirty";

/** Records each statement's SQL text, its values replaced by `?`. */
function recordingTx() {
  const statements: string[] = [];
  const tx = {
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push(Prisma.sql(strings, ...values).sql.replace(/\s+/gu, " ").trim());
      return 1;
    }
  } as unknown as Prisma.TransactionClient;
  return { statements, tx };
}

describe("past-chat index marks", () => {
  it("marks a chat with one upsert that reads no message, only the chat and its state", async () => {
    const { statements, tx } = recordingTx();
    await markChatSearchDirty(tx, { chatId: "chat-1", userId: "owner-1" });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^INSERT INTO "ChatSearchState"/u);
    expect(statements[0]).toContain("ON CONFLICT (\"chatId\") DO UPDATE");
    expect(statements[0]).not.toContain("\"Message\"");
    expect(statements[0]).toContain("\"nextAttemptAt\" = NULL");
    // Always forward, so a pass working on the chat sees its version change.
    expect(statements[0]).toContain("GREATEST(EXCLUDED.\"dirtyAt\", \"ChatSearchState\".\"dirtyAt\" + interval '1 millisecond')");
  });

  it("clears the state row before the passages, in the order the pass locks them", async () => {
    const { statements, tx } = recordingTx();
    await clearChatSearch(tx, { chatId: "chat-1" });
    expect(statements.map((statement) => statement.split(" WHERE")[0])).toEqual([
      "DELETE FROM \"ChatSearchState\"", "DELETE FROM \"ChatSearchPassage\""
    ]);
  });

  it("marks an owner's chats and the re-embedding in chat order, never touching passages", async () => {
    const { statements, tx } = recordingTx();
    await markOwnerChatsSearchDirty(tx, { userId: "owner-1" });
    await scheduleChatSearchReembedding(tx);
    for (const statement of statements) {
      expect(statement).toMatch(/^UPDATE "ChatSearchState"/u);
      expect(statement).toContain("ORDER BY");
      expect(statement).toContain("FOR UPDATE");
      expect(statement).not.toMatch(/UPDATE "ChatSearchPassage"|DELETE/u);
    }
  });
});
