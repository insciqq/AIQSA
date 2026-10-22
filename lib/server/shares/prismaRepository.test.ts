import { describe, expect, it, vi } from "vitest";

vi.mock("../prisma", () => ({ prisma: {} }));
// Only the Project chat test reaches Project access; personal chats never ask.
vi.mock("../projects/access", () => ({ resolveProjectAccess: vi.fn(async () => ({ projectId: "p", role: "MANAGER" })) }));

import { createPrismaShareRepository } from "./prismaRepository";
import { ProjectsDisabledError } from "../projects/disabled";

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
    chat: { findFirst: async () => ({ activeLeafMessageId: "v2", id: "c", messages, project: null, projectId: null, title: "Chat" }) },
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

describe("createChatShare while Projects are disabled", () => {
  it("creates no public share of a Project chat", async () => {
    const create = vi.fn();
    const tx = {
      $queryRaw: vi.fn(async () => []),
      answerReviewSession: { findMany: async () => [] },
      chat: { findFirst: vi.fn(async () => ({ activeLeafMessageId: "a", id: "c", messages, project: { publicSharingEnabled: true, status: "ACTIVE" },
        projectId: "p", title: "Chat" })) },
      message: { findMany: async () => [] },
      sharedChatSnapshot: { create }
    };
    const repository = createPrismaShareRepository({ $transaction: async (work: (client: typeof tx) => unknown) => work(tx) } as never);

    await expect(repository.createChatShare({ activeLeafMessageId: "a", chatId: "c", shareToken: "synthetic", slugHash: "synthetic", userId: "u" }))
      .rejects.toBeInstanceOf(ProjectsDisabledError);
    expect(create).not.toHaveBeenCalled();
    expect(tx.chat.findFirst).toHaveBeenCalledOnce();
  });
});
