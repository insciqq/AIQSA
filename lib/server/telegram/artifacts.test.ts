import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeTelegramBotApi } from "@/tests/support/fakeTelegramBotApi";
import type { ThreadArtifactSummary, ThreadGeneratedArtifact } from "../../contracts/chats";
import failureCodes from "../observability/failureCodes.json";
import {
  createTelegramRunArtifacts, deliverTelegramArtifacts, TELEGRAM_ARTIFACT_LOG_CODES, telegramAnswerArtifacts, telegramArtifactTitle,
  telegramArtifactUrl
} from "./artifacts";
import { createTelegramBotApi, createTelegramPacer } from "./botApi";
import type { TelegramRunEventContext } from "./bridge/events";
import type { TelegramAccessDecision } from "./control/access";
import type { TelegramBotSession } from "./dispatcher";
import { createTelegramRunFiles } from "./files";
import { createTelegramOutbound } from "./outbound";
import type { TelegramLinkRecord } from "./store/links";
import type { TelegramMessageRef } from "./store/messageRefs";
import type { TelegramTransport } from "./transport";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

const BASE = "https://aiqsa.example.com";
const OWNER = { chatId: "chat-1", linkId: "link-1", userId: "user-1" } as const;

function generated(id: string, title: string, version = 1): ThreadGeneratedArtifact {
  return { artifactId: id, entrypoint: "index.html", kind: "html", title, versionId: `${id}-v${version}`, versionNumber: version };
}

/** The real Bot API client and outbound against the fake. */
function setup(transport?: (base: TelegramTransport) => TelegramTransport) {
  const fake = createFakeTelegramBotApi();
  closers.push(() => fake.close());
  const user = fake.inject.addUser();
  const api = createTelegramBotApi({
    pacer: createTelegramPacer({ now: () => 0 }), sleep: async () => {}, token: fake.token,
    transport: transport ? transport(fake.transport) : fake.transport
  });
  const refs: TelegramMessageRef[] = [];
  const outbound = createTelegramOutbound({
    api, botId: fake.bot.id, callbacks: { create: async () => [] },
    messageRefs: { record: async (entries) => { refs.push(...entries); } }
  });
  const session: TelegramBotSession = { api, botId: fake.bot.id, botUsername: fake.bot.username, generation: 1, outbound };
  return { fake, outbound, refs, session, user };
}

describe("Telegram artifacts: which go and where they lead", () => {
  it("lists the artifacts an answer shows in its order, each version once", () => {
    const summary: Pick<ThreadArtifactSummary, "generatedArtifacts"> = {
      generatedArtifacts: [generated("page", "Report"), generated("chart", "Prices", 2), generated("page", "Report")]
    };
    expect(telegramAnswerArtifacts(summary)).toEqual([
      { artifactId: "page", title: "Report", versionId: "page-v1" },
      { artifactId: "chart", title: "Prices", versionId: "chart-v2" }
    ]);
    expect(telegramAnswerArtifacts(null)).toEqual([]);
    expect(telegramAnswerArtifacts({})).toEqual([]);
  });

  it("links the exact version on the installation's own origin, with nothing but its ids", () => {
    expect(telegramArtifactUrl(BASE, { artifactId: "a1", versionId: "v1" })).toBe(`${BASE}/artifacts/a1/versions/v1`);
    expect(telegramArtifactUrl(`${BASE}/some/path/?q=1#x`, { artifactId: "a/b", versionId: "v 1" }))
      .toBe(`${BASE}/artifacts/a%2Fb/versions/v%201`);
    expect(telegramArtifactUrl("http://localhost:3000", { artifactId: "a1", versionId: "v1" })).toBe("http://localhost:3000/artifacts/a1/versions/v1");
    for (const base of ["", "not a url", "ftp://aiqsa.example.com", "javascript:alert(1)", "https://user:secret@aiqsa.example.com"]) {
      expect(telegramArtifactUrl(base, { artifactId: "a1", versionId: "v1" }), base).toBeNull();
    }
  });

  it("shows a title as one bounded line without invisible characters", () => {
    expect(telegramArtifactTitle("  Market\n\treport‮ ")).toBe("Market report");
    expect(telegramArtifactTitle("​\u0000 ")).toBe("Artifact");
    const long = telegramArtifactTitle("x".repeat(400));
    expect(Array.from(long)).toHaveLength(256);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("Telegram artifacts: sending", () => {
  it("sends one message per artifact: its title and an Open button to its web address, referenced to the chat", async () => {
    const h = setup();
    const unsent = await deliverTelegramArtifacts({
      appBaseUrl: BASE, artifacts: telegramAnswerArtifacts({ generatedArtifacts: [generated("page", "Report"), generated("chart", "Prices")] }),
      chatId: h.user.id, outbound: h.outbound, owner: OWNER
    });
    expect(unsent).toEqual([]);
    const messages = h.fake.botMessages(h.user.id);
    expect(messages.map((message) => message.kind)).toEqual(["rich", "rich"]);
    expect(JSON.stringify(messages[0]!.rich_message)).toContain("Report");
    expect(messages.map((message) => message.reply_markup)).toEqual([
      { inline_keyboard: [[{ text: "Open", url: `${BASE}/artifacts/page/versions/page-v1` }]] },
      { inline_keyboard: [[{ text: "Open", url: `${BASE}/artifacts/chart/versions/chart-v1` }]] }
    ]);
    expect(h.refs.map((ref) => ref.chatId)).toEqual(["chat-1", "chat-1"]);
  });

  it("sends the address as text once when Telegram refuses the button, and nothing at all without a usable address", async () => {
    const h = setup();
    h.fake.failNext("sendRichMessage", { description: "Bad Request: BUTTON_URL_INVALID", status: 400 });
    h.fake.failNext("sendMessage", { description: "Bad Request: BUTTON_URL_INVALID", status: 400 });
    const artifacts = telegramAnswerArtifacts({ generatedArtifacts: [generated("page", "Report")] });
    expect(await deliverTelegramArtifacts({ appBaseUrl: BASE, artifacts, chatId: h.user.id, outbound: h.outbound, owner: OWNER })).toEqual([]);
    const [message] = h.fake.botMessages(h.user.id);
    expect(message).toMatchObject({ kind: "text", text: `Report\n${BASE}/artifacts/page/versions/page-v1` });
    expect(message!.reply_markup).toBeUndefined();
    const none = setup();
    expect(await deliverTelegramArtifacts({ appBaseUrl: "not a url", artifacts, chatId: none.user.id, outbound: none.outbound, owner: OWNER }))
      .toEqual(["page-v1"]);
    expect(none.fake.calls()).toHaveLength(0);
  });

  it("never sends again a message Telegram may have received, goes on with the next, and stops at a chat that refuses", async () => {
    let timeouts = 1;
    const h = setup((base) => ({
      ...base,
      call: async (input) => input.method === "sendRichMessage" && timeouts-- > 0 ? { kind: "timeout", ok: false } : base.call(input)
    }));
    const artifacts = telegramAnswerArtifacts({ generatedArtifacts: [generated("a", "First"), generated("b", "Second")] });
    expect(await deliverTelegramArtifacts({ appBaseUrl: BASE, artifacts, chatId: h.user.id, outbound: h.outbound, owner: OWNER })).toEqual([]);
    expect(h.fake.botMessages(h.user.id)).toHaveLength(1);
    expect(JSON.stringify(h.fake.botMessages(h.user.id)[0]!.rich_message)).toContain("Second");

    const refused = setup();
    refused.fake.failNext("sendRichMessage", { status: 403 });
    expect(await deliverTelegramArtifacts({ appBaseUrl: BASE, artifacts, chatId: refused.user.id, outbound: refused.outbound, owner: OWNER }))
      .toEqual(["a-v1", "b-v1"]);
    expect(refused.fake.botMessages(refused.user.id)).toHaveLength(0);
  });

  it("asks right before every message whether the chat may still receive it and sends nothing more once it may not", async () => {
    const h = setup();
    const authorize = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const artifacts = telegramAnswerArtifacts({ generatedArtifacts: [generated("a", "First"), generated("b", "Second")] });
    expect(await deliverTelegramArtifacts({ appBaseUrl: BASE, artifacts, authorize, chatId: h.user.id, outbound: h.outbound, owner: OWNER }))
      .toEqual(["b-v1"]);
    expect(h.fake.botMessages(h.user.id)).toHaveLength(1);
  });
});

describe("Telegram artifacts: after a run's answer and files", () => {
  function link(telegramChatId: number, botId: number): TelegramLinkRecord {
    return {
      botId, currentChatId: "chat-1", displayName: null, id: "link-1", lastSeenAt: new Date(0), linkedAt: new Date(0),
      pendingAssistantId: null, searchEnabled: false, selectedModelId: null, selectedProvider: null, telegramChatId, telegramUserId: telegramChatId,
      telegramUsername: null, userId: "user-1"
    };
  }

  function harness(allowed = true) {
    const h = setup();
    const access = {
      resolveTelegramAccess: vi.fn(async (): Promise<TelegramAccessDecision> => allowed
        ? { allowed: true, control: {} as never, link: link(h.user.id, h.fake.bot.id) }
        : { allowed: false, link: link(h.user.id, h.fake.bot.id), reasonCode: "telegram_access_off" })
    };
    const bytes = new Map<string, Buffer>([["out-1", Buffer.from("done")]]);
    const files = createTelegramRunFiles({
      access, artifacts: createTelegramRunArtifacts({ appBaseUrl: () => BASE }), read: async ({ attachmentId }) => bytes.get(attachmentId) ?? null
    });
    const context: TelegramRunEventContext = {
      bot: h.session, chatId: "chat-1", linkId: "link-1", runId: "run-1", source: "live", telegramChatId: h.user.id, userId: "user-1"
    };
    return { ...h, access, context, files };
  }

  const summary: ThreadArtifactSummary = {
    citations: [], generatedArtifacts: [generated("page", "Research page")],
    generatedFiles: [{ attachmentId: "out-1", byteSize: 4, fileName: "result.txt", mimeType: "text/plain", relativePath: "outputs/result.txt" }],
    reasoningText: [], sources: []
  };

  it("sends the artifacts after the files once the answer reached Telegram, and none twice for a second delivery of it", async () => {
    const h = harness();
    h.files.listener({ artifactSummary: summary, messageIds: [1], sent: true, status: "complete", type: "delivered" }, h.context);
    await h.files.idle();
    expect(h.fake.calls().map((call) => call.method)).toEqual(["sendDocument", "sendRichMessage"]);
    expect(h.fake.lastCall("sendRichMessage")!.params.reply_markup)
      .toEqual({ inline_keyboard: [[{ text: "Open", url: `${BASE}/artifacts/page/versions/page-v1` }]] });
    h.files.listener({ artifactSummary: summary, messageIds: [1], sent: true, status: "complete", type: "delivered" },
      { ...h.context, source: "recovery" });
    await h.files.idle();
    expect(h.fake.calls("sendRichMessage")).toHaveLength(1);
  });

  it("sends an answer's artifacts without files, and nothing for an answer that did not reach Telegram or whose access is off", async () => {
    const h = harness();
    const only: ThreadArtifactSummary = { citations: [], generatedArtifacts: [generated("page", "Page")], reasoningText: [], sources: [] };
    h.files.listener({ artifactSummary: only, messageIds: [], sent: false, status: "complete", type: "delivered" }, h.context);
    await h.files.idle();
    expect(h.fake.calls()).toHaveLength(0);
    h.files.listener({ artifactSummary: only, messageIds: [1], sent: true, status: "complete", type: "delivered" }, h.context);
    await h.files.idle();
    expect(h.fake.calls().map((call) => call.method)).toEqual(["sendRichMessage"]);
    const off = harness(false);
    off.files.listener({ artifactSummary: only, messageIds: [1], sent: true, status: "complete", type: "delivered" }, off.context);
    await off.files.idle();
    expect(off.fake.calls()).toHaveLength(0);
  });

  it("registers its codes among the sorted failure codes", () => {
    const registry = failureCodes as string[];
    for (const code of TELEGRAM_ARTIFACT_LOG_CODES) {
      const index = registry.indexOf(code);
      expect(index, code).toBeGreaterThan(0);
      expect(registry[index - 1]! < code && code < registry[index + 1]!, code).toBe(true);
    }
  });
});
