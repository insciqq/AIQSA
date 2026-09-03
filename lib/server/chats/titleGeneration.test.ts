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
      snapshot: { providerFamily: "openai", providerModelId: "gpt-5.2" }
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
  it("writes the generated title only while the heuristic title still stands and reports usage", async () => {
    const applyTitle = vi.fn(async () => true);
    const executeStructuredOutput = vi.fn(async (_role, _request, options) => {
      options.onUsage?.({ inputTokens: 120, outputTokens: 8, reasoningTokens: 0, totalTokens: 128 });
      return { title: "TCP versus UDP" };
    });
    const generator = createChatTitleGenerator({
      applyTitle,
      executeStructuredOutput,
      loadFirstTurn: async () => ({ expectedTitle: "Explain TCP vs UDP. Include a", questionText: "Explain TCP vs UDP." }),
      resolveSystemModel: async () => resolution()
    });
    const outcome = await generator.generate(context);
    expect(outcome).toEqual({
      status: "generated",
      title: "TCP versus UDP",
      usage: { modelId: "gpt-5.2", provider: "openai", usage: { inputTokens: 120, outputTokens: 8, reasoningTokens: 0, totalTokens: 128 } }
    });
    expect(applyTitle).toHaveBeenCalledWith({
      chatId: "chat-1",
      expectedTitle: "Explain TCP vs UDP. Include a",
      title: "TCP versus UDP",
      userId: "user-1"
    });
    expect(executeStructuredOutput.mock.calls[0]?.[2]).toMatchObject({ timeoutMs: 8_000 });
  });

  it("skips later turns, customized titles and installations without a System Model", async () => {
    const executeStructuredOutput = vi.fn();
    const base = {
      applyTitle: vi.fn(async () => true),
      executeStructuredOutput,
      resolveSystemModel: async () => resolution()
    };
    expect(await createChatTitleGenerator({ ...base, loadFirstTurn: async () => null }).generate(context))
      .toEqual({ reason: "not_first_turn", status: "skipped" });
    expect(await createChatTitleGenerator({ ...base, loadFirstTurn: async () => "customized" }).generate(context))
      .toEqual({ reason: "title_customized", status: "skipped" });
    const turn = { expectedTitle: "Hello", questionText: "Hello" };
    expect(await createChatTitleGenerator({
      ...base,
      loadFirstTurn: async () => turn,
      resolveSystemModel: async () => ({ code: "system_model_absent", ok: false })
    }).generate(context)).toEqual({ reason: "system_model_absent", status: "skipped" });
    expect(await createChatTitleGenerator({
      ...base,
      loadFirstTurn: async () => turn,
      resolveSystemModel: async () => resolution(false)
    }).generate(context)).toEqual({ reason: "system_model_unsupported", status: "skipped" });
    expect(executeStructuredOutput).not.toHaveBeenCalled();
  });

  it("never throws: provider failures report the usage seen so far and a lost race skips", async () => {
    const failing = createChatTitleGenerator({
      applyTitle: vi.fn(async () => true),
      executeStructuredOutput: async (_role, _request, options) => {
        options.onUsage?.({ inputTokens: 50, outputTokens: 0, reasoningTokens: 0, totalTokens: 50 });
        throw new Error("provider_unavailable");
      },
      loadFirstTurn: async () => ({ expectedTitle: "Hello", questionText: "Hello" }),
      resolveSystemModel: async () => resolution()
    });
    expect(await failing.generate(context)).toEqual({
      status: "failed",
      usage: { modelId: "gpt-5.2", provider: "openai", usage: { inputTokens: 50, outputTokens: 0, reasoningTokens: 0, totalTokens: 50 } }
    });

    const renamedMeanwhile = createChatTitleGenerator({
      applyTitle: vi.fn(async () => false),
      executeStructuredOutput: async () => ({ title: "Greeting" }),
      loadFirstTurn: async () => ({ expectedTitle: "Hello", questionText: "Hello" }),
      resolveSystemModel: async () => resolution()
    });
    expect(await renamedMeanwhile.generate(context)).toEqual({ reason: "title_customized", status: "skipped" });
  });
});

describe("loadChatTitleFirstTurn", () => {
  const content = { blocks: [{ text: "Explain TCP vs UDP with a table and a code sample please", type: "text" }] };

  function client(chat: unknown) {
    const findFirst = vi.fn(async () => chat);
    return { chat: { findFirst } } as unknown as Pick<PrismaClient, "chat"> & { chat: { findFirst: typeof findFirst } };
  }

  it("returns the question and the heuristic title for a two-message personal chat", async () => {
    const chat = { _count: { messages: 2 }, messages: [{ content }], title: titleFromMessageContent(content) };
    const db = client(chat);
    await expect(loadChatTitleFirstTurn(db, context)).resolves.toEqual({
      expectedTitle: titleFromMessageContent(content),
      questionText: "Explain TCP vs UDP with a table and a code sample please"
    });
    expect(db.chat.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "chat-1", projectId: null, userId: "user-1" })
    }));
  });

  it("reports customized titles and ignores later turns or missing chats", async () => {
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
