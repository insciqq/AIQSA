import { describe, expect, it, vi } from "vitest";

vi.mock("../prisma", () => ({ prisma: {} }));

import { createPrismaShareRepository } from "./prismaRepository";

/** A public share holds the selected leaf's path only, each message as stored. */

type Row = Readonly<{
  content: unknown;
  id: string;
  parentMessageId: string | null;
  role: string;
  status: string;
  systemTurnKind: string | null;
}>;

function row(id: string, parentMessageId: string | null, role: string, text: string): Row {
  return { content: { blocks: [{ text, type: "text" }] }, id, parentMessageId, role, status: "complete", systemTurnKind: null };
}

// Turns the removed Answer Review once wrote read as ordinary turns since its storage was dropped.
const messages = [
  row("q", null, "user", "Question"),
  row("a", "q", "assistant", "Shared answer"),
  row("review", "a", "user", "Review request"),
  row("critique", "review", "assistant", "Critique"),
  row("revise", "critique", "user", "Revision request"),
  row("v2", "revise", "assistant", "Later revision")
];

async function share(activeLeafMessageId: string) {
  const created: unknown[] = [];
  const tx = {
    chat: { findFirst: async () => ({ activeLeafMessageId: "v2", id: "c", messages, title: "Chat" }) },
    message: { findMany: async () => [] },
    sharedChatSnapshot: { create: async ({ data }: { data: unknown }) => { created.push(data); return { id: "share" }; } }
  };
  const repository = createPrismaShareRepository({ $transaction: async (work: (client: typeof tx) => unknown) => work(tx) } as never);
  await repository.createChatShare({ activeLeafMessageId, chatId: "c", shareToken: "synthetic", slugHash: "synthetic", userId: "u" });
  const [data] = created as Array<{ snapshot: { messages: Array<{ content: unknown; role: string }> } }>;
  return data!.snapshot.messages.map((message) => `${message.role}:${JSON.stringify(message.content)}`);
}

describe("createChatShare along a branch", () => {
  it("shares the selected answer, not what followed it", async () => {
    const shown = await share("a");
    expect(shown.join("\n")).toContain("Shared answer");
    expect(shown.join("\n")).not.toContain("Later revision");
    expect(shown).toHaveLength(2);
  });

  it("shares every turn of the selected leaf's path as stored", async () => {
    const shown = await share("v2");
    expect(shown.map((entry) => entry.split(":")[0])).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
    expect(shown.join("\n")).toMatch(/Shared answer[\s\S]*Review request[\s\S]*Critique[\s\S]*Revision request[\s\S]*Later revision/u);
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

describe("createChatShare for a service account's chat", () => {
  async function shareDiscord(kind: "service" | "person") {
    const created: Array<{ snapshot: { messages: Array<{ content: { blocks: Array<{ text: string }> } }>; title: string }; title: string }> = [];
    const findFirst = vi.fn(async () => ({ activeLeafMessageId: "a", id: "c", title: "Thread token=abcd1234efgh5678ijkl", user: { kind }, messages: [
      row("q", null, "user", "Question from Alice (discord:1100000000000000020):\nWhat is DB_PASSWORD?"),
      row("a", "q", "assistant", "It is DB_PASSWORD=s3cr3t-Value-Only-Here and the key sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd")
    ] }));
    const tx = {
      chat: { findFirst },
      message: { findMany: async () => [] },
      sharedChatSnapshot: { create: async ({ data }: { data: (typeof created)[number] }) => { created.push(data); return { id: "share" }; } }
    };
    const repository = createPrismaShareRepository({ $transaction: async (work: (client: typeof tx) => unknown) => work(tx) } as never);
    await repository.createChatShare({ activeLeafMessageId: "a", chatId: "c", shareToken: "synthetic", slugHash: "synthetic", userId: "u" });
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ include: expect.objectContaining({ user: { select: { kind: true } } }) }));
    return created[0]!;
  }

  // The decision reads the owner, so a chat whose Discord conversation row was never written is redacted all the same.
  it("redacts the secrets of a service account's chat, its title included, with or without a Discord conversation row", async () => {
    const data = await shareDiscord("service");
    const text = JSON.stringify(data);
    expect(text).not.toContain("s3cr3t-Value-Only-Here");
    expect(text).not.toContain("sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(text).not.toContain("abcd1234efgh5678ijkl");
    expect(text).toContain("[redacted]");
    expect(data.snapshot.messages[0]!.content.blocks[0]!.text).toContain("What is DB_PASSWORD?");
    expect(data.title).toBe(data.snapshot.title);
  });

  it("keeps a person's chat text as it is", async () => {
    const data = await shareDiscord("person");
    expect(JSON.stringify(data)).toContain("s3cr3t-Value-Only-Here");
  });
});
