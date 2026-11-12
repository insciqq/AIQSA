import { describe, expect, it, vi } from "vitest";

vi.mock("../prisma", () => ({ prisma: {} }));

import { createPrismaShareRepository } from "./prismaRepository";

/**
 * A public share holds the selected leaf's path only: an answer review that
 * went on past the selected answer (a later version) stays out, while a
 * shared review leaf reads as its group's latest version without the review
 * turns.
 */

type Row = Readonly<{
  answerReviewSessionId: string | null;
  content: unknown;
  id: string;
  parentMessageId: string | null;
  role: string;
  status: string;
  systemTurnKind: string | null;
}>;

function row(id: string, parentMessageId: string | null, role: string, text: string,
  session: string | null = null, systemTurnKind: string | null = null): Row {
  return { answerReviewSessionId: session, content: { blocks: [{ text, type: "text" }] }, id, parentMessageId, role,
    status: "complete", systemTurnKind };
}

const messages = [
  row("q", null, "user", "Question"),
  row("a", "q", "assistant", "Shared answer"),
  row("review", "a", "user", "Review request", "s", "answer_review_request"),
  row("critique", "review", "assistant", "Critique", "s"),
  row("revise", "critique", "user", "Revision request", "s", "answer_revision_request"),
  row("v2", "revise", "assistant", "Later revision", "s")
];

async function share(activeLeafMessageId: string) {
  const created: unknown[] = [];
  const tx = {
    answerReviewSession: { findMany: async () => [{ id: "s", sourceAssistantMessageId: "a" }] },
    discordConversation: { findUnique: async () => null },
    chat: { findFirst: async () => ({ activeLeafMessageId: "v2", id: "c", messages, title: "Chat" }) },
    message: { findMany: async () => [] },
    sharedChatSnapshot: { create: async ({ data }: { data: unknown }) => { created.push(data); return { id: "share" }; } }
  };
  const repository = createPrismaShareRepository({ $transaction: async (work: (client: typeof tx) => unknown) => work(tx) } as never);
  await repository.createChatShare({ activeLeafMessageId, chatId: "c", shareToken: "synthetic", slugHash: "synthetic", userId: "u" });
  const [data] = created as Array<{ snapshot: { messages: Array<{ content: unknown; role: string }> } }>;
  return data!.snapshot.messages.map((message) => `${message.role}:${JSON.stringify(message.content)}`);
}

describe("createChatShare with answer reviews", () => {
  it("shares the selected answer, not a later review version of it", async () => {
    const shown = await share("a");
    expect(shown.join("\n")).toContain("Shared answer");
    expect(shown.join("\n")).not.toContain("Later revision");
    expect(shown).toHaveLength(2);
  });

  it("shares a review leaf as its latest version without the review turns", async () => {
    const shown = await share("v2");
    expect(shown).toHaveLength(2);
    expect(shown[1]).toContain("Later revision");
    expect(shown.join("\n")).not.toMatch(/Review request|Critique|Revision request|Shared answer/u);
  });
});

describe("createChatShare with quiet checks", () => {
  const turn = (id: string, parentMessageId: string | null) => ({ ...row(id, parentMessageId, "user", "Check the release page"),
    branchSourceModelRunId: null, scheduledTaskPrompt: true });
  const checks = [turn("b", null), row("b-a", "b", "assistant", "Version 1.0 is current."), turn("q1", "b-a"),
    row("q1-a", "q1", "assistant", ""), turn("u", "q1-a"), row("u-a", "u", "assistant", "Version 2.0 is out."), turn("q2", "u-a"),
    row("q2-a", "q2", "assistant", "")];
  const outcomes: Record<string, string> = { b: "baseline", q1: "no_update", q2: "no_update", u: "update" };

  async function shareChecks(activeLeafMessageId: string | null) {
    const created: Array<{ snapshot: { messages: Array<{ content: { blocks: Array<{ text: string }> }; role: string }> } }> = [];
    const tx = {
      answerReviewSession: { findMany: async () => [] },
      discordConversation: { findUnique: async () => null },
      chat: { findFirst: async () => ({ activeLeafMessageId: "q2-a", id: "c", messages: checks, title: "Chat" }) },
      message: { findMany: async () => [] },
      modelRun: { findMany: async (args: { where: { userMessageId: { in: string[] } } }) => args.where.userMessageId.in
        .map((userMessageId) => ({ scheduledOutcome: outcomes[userMessageId] ?? null, userMessageId })) },
      sharedChatSnapshot: { create: async ({ data }: { data: (typeof created)[number] }) => { created.push(data); return { id: "share" }; } }
    };
    const repository = createPrismaShareRepository({ $transaction: async (work: (client: typeof tx) => unknown) => work(tx) } as never);
    await repository.createChatShare({ activeLeafMessageId, chatId: "c", shareToken: "synthetic", slugHash: "synthetic", userId: "u" });
    return created[0]!.snapshot;
  }

  it("leaves quiet checks out of the snapshot and shares up to the latest shown result", async () => {
    // The chat's stored leaf is a quiet check; the browser names the result it was shown.
    for (const leaf of [null, "q2-a", "u-a"]) {
      const snapshot = await shareChecks(leaf);
      expect(snapshot.messages.map((message) => `${message.role}:${message.content.blocks.map((block) => block.text).join("")}`)).toEqual([
        "user:Check the release page", "assistant:Version 1.0 is current.", "user:Check the release page", "assistant:Version 2.0 is out."
      ]);
    }
  });
});

describe("createChatShare ownership", () => {
  it("shares only the requester's own chat and records them as its owner", async () => {
    const create = vi.fn(async () => ({ id: "share" }));
    const tx = {
      answerReviewSession: { findMany: async () => [] },
      discordConversation: { findUnique: async () => null },
      chat: { findFirst: vi.fn(async () => ({ activeLeafMessageId: "a", id: "c", messages, title: "Chat" })) },
      message: { findMany: async () => [] },
      sharedChatSnapshot: { create }
    };
    const repository = createPrismaShareRepository({ $transaction: async (work: (client: typeof tx) => unknown) => work(tx) } as never);

    await repository.createChatShare({ activeLeafMessageId: "a", chatId: "c", shareToken: "synthetic", slugHash: "synthetic", userId: "u" });
    expect(tx.chat.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "c", userId: "u" }) }));
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ chatId: "c", ownerUserId: "u" }) });
  });
});

describe("createChatShare for a Discord chat", () => {
  async function shareDiscord(bound: boolean) {
    const created: Array<{ snapshot: { messages: Array<{ content: { blocks: Array<{ text: string }> } }>; title: string }; title: string }> = [];
    const tx = {
      answerReviewSession: { findMany: async () => [] },
      chat: { findFirst: async () => ({ activeLeafMessageId: "a", id: "c", title: "Thread token=abcd1234efgh5678ijkl", messages: [
        row("q", null, "user", "Question from Alice (discord:1100000000000000020):\nWhat is DB_PASSWORD?"),
        row("a", "q", "assistant", "It is DB_PASSWORD=s3cr3t-Value-Only-Here and the key sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd")
      ] }) },
      discordConversation: { findUnique: vi.fn(async () => (bound ? { id: "conversation-1" } : null)) },
      message: { findMany: async () => [] },
      sharedChatSnapshot: { create: async ({ data }: { data: (typeof created)[number] }) => { created.push(data); return { id: "share" }; } }
    };
    const repository = createPrismaShareRepository({ $transaction: async (work: (client: typeof tx) => unknown) => work(tx) } as never);
    await repository.createChatShare({ activeLeafMessageId: "a", chatId: "c", shareToken: "synthetic", slugHash: "synthetic", userId: "u" });
    expect(tx.discordConversation.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { chatId: "c" } }));
    return created[0]!;
  }

  it("redacts the secrets of a chat bound to a Discord conversation, its title included", async () => {
    const data = await shareDiscord(true);
    const text = JSON.stringify(data);
    expect(text).not.toContain("s3cr3t-Value-Only-Here");
    expect(text).not.toContain("sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(text).not.toContain("abcd1234efgh5678ijkl");
    expect(text).toContain("[redacted]");
    expect(data.snapshot.messages[0]!.content.blocks[0]!.text).toContain("What is DB_PASSWORD?");
    expect(data.title).toBe(data.snapshot.title);
  });

  it("keeps another chat's text as it is", async () => {
    const data = await shareDiscord(false);
    expect(JSON.stringify(data)).toContain("s3cr3t-Value-Only-Here");
  });
});
