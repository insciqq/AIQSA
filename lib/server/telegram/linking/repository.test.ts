import { describe, expect, it } from "vitest";
import { createPrismaTelegramLinkingRepository } from "./repository";

/**
 * Disconnecting in one transaction under the account lock: the link goes and
 * the user's unused link codes are voided with it (the stateful suite checks
 * the same against the database).
 */

function fakeClient(link: { botId: bigint; id: string; telegramChatId: bigint } | null) {
  const calls: string[] = [];
  const tx = {
    $queryRaw: async () => { calls.push("lock"); return []; },
    telegramLink: {
      findFirst: async () => { calls.push("find link"); return link; },
      deleteMany: async () => { calls.push("delete link"); return { count: link ? 1 : 0 }; }
    },
    telegramLinkCode: {
      deleteMany: async (args: unknown) => { calls.push(`void codes ${JSON.stringify(args)}`); return { count: 1 }; }
    }
  };
  const client = { $transaction: async (work: (client: typeof tx) => Promise<unknown>) => { calls.push("begin"); return work(tx); } };
  return { calls, repository: createPrismaTelegramLinkingRepository(client as never) };
}

const VOID = `void codes ${JSON.stringify({ where: { consumedAt: null, userId: "user-1" } })}`;
const LINK = { botId: 42n, id: "link-1", telegramChatId: 7n };

describe("Telegram disconnect voids pending link codes", () => {
  it("removes the link and the unused codes after locking the account", async () => {
    const { calls, repository } = fakeClient(LINK);
    await expect(repository.unlink("user-1")).resolves.toEqual({ botId: 42, telegramChatId: 7 });
    expect(calls).toEqual(["begin", "lock", "find link", "delete link", VOID]);
  });

  it("voids the unused codes of a user with no link and still reports nothing removed", async () => {
    const { calls, repository } = fakeClient(null);
    await expect(repository.unlink("user-1")).resolves.toBeNull();
    expect(calls).toEqual(["begin", "lock", "find link", VOID]);
  });

  it("voids them with the link a /unlink button names, and leaves them for a stale button", async () => {
    const current = fakeClient(LINK);
    await expect(current.repository.unlinkLink({ linkId: "link-1", userId: "user-1" })).resolves.toEqual({ botId: 42, telegramChatId: 7 });
    expect(current.calls).toEqual(["begin", "lock", "find link", "delete link", VOID]);

    const stale = fakeClient(null);
    await expect(stale.repository.unlinkLink({ linkId: "link-0", userId: "user-1" })).resolves.toBeNull();
    expect(stale.calls).toEqual(["begin", "lock", "find link"]);
  });
});
