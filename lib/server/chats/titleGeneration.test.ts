import { chatTitleWork } from "@/tests/support/chatTitles";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { ProviderAdmissionRole } from "../providerRuntime/admission";
import type { SystemModelRoleResolution } from "../providerRuntime/systemModelRole";
import {
  buildChatTitleRequest,
  createChatTitleGenerator,
  loadChatTitleFirstTurn,
  normalizeGeneratedChatTitle
} from "./titleGeneration";
import { titleFromMessageContent } from "./titlePolicy";

const context = {
  answerText: "TCP guarantees delivery; UDP trades that for latency.",
  chatId: "chat-1",
  runId: "run-1",
  userId: "user-1",
  userMessageId: "message-1"
};

function resolution(structuredOutput = true): SystemModelRoleResolution {
  return {
    credentialScope: "installation",
    ok: true,
    policyVersion: 3,
    providerModelId: "gpt-5.2",
    reasoningEffort: "low",
    role: {
      credentialSource: "default",
      modelConfiguration: { capabilities: { structuredOutput } },
      snapshot: chatTitleWork().providerSnapshot
    } as unknown as ProviderAdmissionRole
  };
}

describe("normalizeGeneratedChatTitle", () => {
  it("strips wrapping quotes, a Title: prefix and trailing periods", () => {
    expect(normalizeGeneratedChatTitle('  "TCP versus UDP basics."  ')).toBe("TCP versus UDP basics");
    expect(normalizeGeneratedChatTitle("Title: «Квартальный отчёт по финансам»")).toBe("Квартальный отчёт по финансам");
  });

  it("bounds long titles at a word boundary and rejects empty output", () => {
    const long = normalizeGeneratedChatTitle("A very long conversation title about networking protocols and their history in detail");
    expect(long).toBe("A very long conversation title about networking");
    expect(normalizeGeneratedChatTitle("\"\"")).toBeNull();
    expect(normalizeGeneratedChatTitle(42)).toBeNull();
  });
});

describe("buildChatTitleRequest", () => {
  it("bounds the excerpts and asks for one short title in the user's language", () => {
    const request = buildChatTitleRequest({
      answerText: "b".repeat(2_000),
      questionText: "a".repeat(2_000),
      reasoningEffort: "low"
    });
    expect(request.name).toBe("chat_title");
    expect(request.maxOutputTokens).toBe(64);
    expect(request.reasoningEffort).toBe("low");
    expect(request.schema).toMatchObject({ required: ["title"], type: "object" });
    expect(request.userPrompt.length).toBeLessThan(3_000);
    expect(request.userPrompt).toContain("<question>");
    expect(request.systemPrompt).toMatch(/three to six words/u);
    expect(request.systemPrompt).toMatch(/language of the user/u);
  });
});

describe("createChatTitleGenerator", () => {
  it("admits bounded first-turn work with the exact destination without provider execution", async () => {
    const enqueue = vi.fn<(work: import("./titleGeneration").ChatTitleWork) => Promise<void>>(async () => undefined);
    const generator = createChatTitleGenerator({
      enqueue,
      loadFirstTurn: async () => ({ expectedTitle: "Explain TCP versus UDP", questionText: "Q".repeat(4_000), titleRevision: 3 }),
      resolveTitleModel: async () => resolution()
    });
    await generator.schedule({ ...context, answerText: "A".repeat(4_000) });
    expect(enqueue).toHaveBeenCalledOnce();
    const work = enqueue.mock.calls[0]?.[0];
    expect(work).toMatchObject({ chatId: context.chatId, runId: context.runId, userId: context.userId,
      expectedTitle: "Explain TCP versus UDP", titleRevision: 3, reasoningEffort: "low",
      providerSnapshot: { credentialId: "title-credential", credentialVersionId: "title-credential-version", providerModelId: "title-model" }
    });
    expect(work?.questionText.length).toBeLessThanOrEqual(1_201);
    expect(work?.answerText.length).toBeLessThanOrEqual(1_601);
  });

  it.each(["later", "customized", "absent", "unsupported"] as const)("does not enqueue %s work", async (kind) => {
    const enqueue = vi.fn();
    const generator = createChatTitleGenerator({
      enqueue,
      loadFirstTurn: async () => kind === "later" ? null : kind === "customized" ? "customized" :
        { expectedTitle: "Hello", questionText: "Hello", titleRevision: 0 },
      resolveTitleModel: async () => kind === "absent" ? { code: "system_model_absent", ok: false } : resolution(kind !== "unsupported")
    });
    await generator.schedule(context);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("loadChatTitleFirstTurn", () => {
  const content = { blocks: [{ text: "Explain TCP vs UDP with a table and a code sample please", type: "text" }] };

  function client(chat: unknown) {
    const findFirst = vi.fn(async () => chat);
    return { chat: { findFirst } } as unknown as Pick<PrismaClient, "chat"> & { chat: { findFirst: typeof findFirst } };
  }

  it("returns the question and the heuristic title for a two-message personal chat", async () => {
    const chat = { _count: { messages: 2 }, messages: [{ content }], title: titleFromMessageContent(content), titleRevision: 0 };
    const db = client(chat);
    await expect(loadChatTitleFirstTurn(db, context)).resolves.toEqual({
      expectedTitle: titleFromMessageContent(content),
      questionText: "Explain TCP vs UDP with a table and a code sample please",
      titleRevision: 0
    });
    expect(db.chat.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "chat-1", projectId: null, userId: "user-1" })
    }));
  });

  it("reports customized titles and ignores later turns or missing chats", async () => {
    await expect(loadChatTitleFirstTurn(
      client({ _count: { messages: 2 }, messages: [{ content }], title: titleFromMessageContent(content), titleRevision: 1 }), context
    )).resolves.toBe("customized");
    await expect(loadChatTitleFirstTurn(
      client({ _count: { messages: 2 }, messages: [{ content }], title: "My own name" }),
      context
    )).resolves.toBe("customized");
    await expect(loadChatTitleFirstTurn(
      client({ _count: { messages: 4 }, messages: [{ content }], title: titleFromMessageContent(content) }),
      context
    )).resolves.toBeNull();
    await expect(loadChatTitleFirstTurn(client(null), context)).resolves.toBeNull();
  });
});
