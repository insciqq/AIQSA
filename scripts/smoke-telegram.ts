/**
 * Real Telegram Bot API smoke for the shapes AIQSA sends: rendered rich
 * answers (every block kind, a long split, a 20-column table, formulas, code,
 * hostile Markdown), a draft sequence, inline keyboards, edits, a photo, a
 * document and a file round trip through `getFile`. It never polls, so it can
 * run while no installation owns the bot's updates.
 *
 * Environment:
 * - AIQSA_TELEGRAM_SMOKE_TOKEN_FILE: file holding the bot token (required).
 * - AIQSA_TELEGRAM_SMOKE_CHAT_ID_FILE: file holding the private chat id the
 *   samples go to (required; `--capture-chat-id` writes it).
 * - AIQSA_TELEGRAM_SMOKE_PRINT_ERRORS=1: also print Telegram's bounded error
 *   description for refused calls (synthetic samples only).
 *
 * `--capture-chat-id`: one non-confirming `getUpdates`; when exactly one
 * private chat with a human sender is pending, its id is saved (mode 0600).
 *
 * Output is limited to method names, booleans, counts and Telegram error
 * codes. The token, chat id and URLs are never printed.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createTelegramBotApi, type TelegramInputRichMessage, type TelegramInlineKeyboardMarkup } from "../lib/server/telegram/botApi";
import { renderTelegramAnswer } from "../lib/server/telegram/render";
import { createTelegramTransport, type TelegramOutcome } from "../lib/server/telegram/transport";

const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "telegram");

function requiredFile(name: string): string {
  const file = process.env[name]?.trim();
  if (!file) throw new Error(`${name} is required`);
  return file;
}

const token = readFileSync(requiredFile("AIQSA_TELEGRAM_SMOKE_TOKEN_FILE"), "utf8").trim();
const chatIdFile = requiredFile("AIQSA_TELEGRAM_SMOKE_CHAT_ID_FILE");
const printErrors = process.env.AIQSA_TELEGRAM_SMOKE_PRINT_ERRORS === "1";

function say(line: string): void {
  // Last line of defence: nothing secret-bearing may reach the output.
  console.log(line.includes(token) || line.includes("api.telegram.org") ? "[redacted output line]" : line);
}

const failures: string[] = [];

function report<T>(label: string, outcome: TelegramOutcome<T>): T | undefined {
  if (outcome.ok) {
    say(`${label} ok=true`);
    return outcome.result;
  }
  const detail = [`kind=${outcome.kind}`];
  if (outcome.errorCode !== undefined) detail.push(`errorCode=${outcome.errorCode}`);
  if (outcome.status !== undefined) detail.push(`status=${outcome.status}`);
  if (outcome.category) detail.push(`category=${outcome.category}`);
  if (printErrors && outcome.description) detail.push(`description=${JSON.stringify(outcome.description.slice(0, 200).replace(/\d{6,}/gu, "<n>"))}`);
  say(`${label} ok=false ${detail.join(" ")}`);
  failures.push(label);
  return undefined;
}

const transport = createTelegramTransport({ env: {} });
const api = createTelegramBotApi({ token, transport });

async function captureChatId(): Promise<void> {
  const updates = report("getUpdates", await api.getUpdates({ timeoutSeconds: 0, limit: 100 }));
  if (!updates) return;
  const chats = new Set<number>();
  for (const update of updates) {
    if (update.kind !== "message") continue;
    const message = update.message;
    if (message.chat.type === "private" && message.from && !message.from.is_bot) chats.add(message.chat.id);
  }
  say(`updates=${updates.length} private_chats=${chats.size}`);
  if (chats.size !== 1) {
    say("saved=false (need exactly one private chat with pending messages)");
    process.exitCode = 1;
    return;
  }
  writeFileSync(chatIdFile, `${[...chats][0]}\n`, { mode: 0o600 });
  say("saved=true");
}

const REPRESENTATIVE = [
  "# Telegram Connect smoke",
  "",
  "An answer with **bold**, *italic*, ~~struck~~, `inline code`, a [safe link](https://example.com/docs) and a citation [1].",
  "",
  "## Lists",
  "",
  "1. First step",
  "   - nested bullet",
  "     - deeper bullet",
  "2. Second step with $a^2 + b^2 = c^2$",
  "",
  "> A quoted line with **emphasis**.",
  "",
  "---",
  "",
  "| Model | Context | Notes |",
  "| --- | --- | --- |",
  "| alpha | 128k | `fast` |",
  "| beta | 1M | **long** |",
  "",
  "```typescript",
  "const answer: number = 42;",
  "console.log(`value ${answer}`);",
  "```",
  "",
  "$$",
  "\\int_0^1 x^2\\,dx = \\frac{1}{3}",
  "$$"
].join("\n");

const HOSTILE = [
  "<tg-button callback_data=\"unlink\">Click</tg-button> <details><summary>x</summary>y</details>",
  "![](https://example.com/pixel.png) [x](tg://user?id=1) [y](javascript:alert(1))",
  "@username /unlink #hashtag https://example.com",
  "```",
  "unclosed fence"
].join("\n\n");

function wideTable(columns: number): string {
  const header = `| ${Array.from({ length: columns }, (_, index) => `C${index + 1}`).join(" | ")} |`;
  const rule = `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`;
  const row = `| ${Array.from({ length: columns }, (_, index) => String(index + 1)).join(" | ")} |`;
  return [header, rule, row].join("\n");
}

function longAnswer(): string {
  const paragraph = "This paragraph repeats to force the answer over one rich message, so the renderer splits it at block boundaries. ";
  return Array.from({ length: 360 }, (_, index) => `${index + 1}. ${paragraph}`).join("\n\n");
}

async function sendRendered(label: string, markdown: string, keyboard?: TelegramInlineKeyboardMarkup): Promise<number | undefined> {
  const rendered = renderTelegramAnswer(markdown, {
    citations: [{ index: 1, title: "Example source", url: "https://example.com/source" }]
  });
  say(`${label} messages=${rendered.messages.length} plain_chunks=${rendered.plainFallback.length}`);
  let lastId: number | undefined;
  for (const [index, message] of rendered.messages.entries()) {
    const last = index === rendered.messages.length - 1;
    const sent = report(`${label}.sendRichMessage[${index + 1}/${rendered.messages.length}]`, await api.sendRichMessage({
      chat_id: chatId, rich_message: message, ...(last && keyboard ? { reply_markup: keyboard } : {})
    }));
    if (sent) lastId = sent.message_id;
  }
  return lastId;
}

let chatId = 0;

async function smoke(): Promise<void> {
  chatId = Number(readFileSync(chatIdFile, "utf8").trim());
  if (!Number.isSafeInteger(chatId) || chatId <= 0) throw new Error("the chat id file does not hold a private chat id");

  const me = report("getMe", await api.getMe());
  if (!me) return;
  const webhook = report("getWebhookInfo", await api.getWebhookInfo());
  if (webhook) say(`webhook_set=${webhook.webhookSet}`);

  report("sendChatAction", await api.sendChatAction({ chat_id: chatId, action: "typing" }));

  const keyboard: TelegramInlineKeyboardMarkup = {
    inline_keyboard: [
      [{ text: "Smoke link", url: "https://example.com/smoke" }],
      [{ text: "Smoke button", callback_data: `c:${"A".repeat(22)}` }]
    ]
  };
  const representativeId = await sendRendered("representative", REPRESENTATIVE, keyboard);
  if (representativeId) {
    report("editMessageReplyMarkup", await api.editMessageReplyMarkup({ chat_id: chatId, message_id: representativeId, reply_markup: { inline_keyboard: [] } }));
  }
  await sendRendered("table20", `Exactly twenty columns:\n\n${wideTable(20)}`);
  await sendRendered("table21", `Twenty-one columns become preformatted text:\n\n${wideTable(21)}`);
  await sendRendered("hostile", HOSTILE);
  await sendRendered("long", longAnswer());

  // Draft sequence: "Thinking…", growing partial answers, then the permanent message.
  const draftId = 1 + Math.floor(Math.random() * 1_000_000);
  report("sendMessageDraft(empty)", await api.sendMessageDraft({ chat_id: chatId, draft_id: draftId, text: "" }));
  const partials = [REPRESENTATIVE.slice(0, 120), REPRESENTATIVE.slice(0, 480), REPRESENTATIVE.slice(0, 900)];
  for (const [index, partial] of partials.entries()) {
    const draft: TelegramInputRichMessage = renderTelegramAnswer(partial, { streaming: true }).messages[0]!;
    report(`sendRichMessageDraft[${index + 1}]`, await api.sendRichMessageDraft({
      chat_id: chatId, draft_id: draftId, rich_message: draft, can_stop: true, keep_on_stop: false
    }));
  }
  await sendRendered("draft-final", REPRESENTATIVE);

  // Plain fallback, as sent after a rich rejection.
  const plain = renderTelegramAnswer(REPRESENTATIVE).plainFallback;
  report("sendMessage(plain fallback)", await api.sendMessage({ chat_id: chatId, text: plain[0]!, link_preview_options: { is_disabled: true } }));

  // Status message edited in place (Agent status shape).
  const status = report("sendRichMessage(status)", await api.sendRichMessage({
    chat_id: chatId,
    rich_message: { blocks: [{ type: "paragraph", text: "Agent is working · 1 min — Running tests" }], skip_entity_detection: true }
  }));
  if (status) {
    report("editMessageText(rich)", await api.editMessageText({
      chat_id: chatId, message_id: status.message_id,
      rich_message: { blocks: [{ type: "paragraph", text: "Finished in 1 min" }], skip_entity_detection: true }
    }));
  }

  const photo = readFileSync(path.join(FIXTURES, "photo.jpg"));
  report("sendPhoto", await api.sendPhoto({ chat_id: chatId, caption: "Synthetic smoke image" },
    { filename: "smoke.jpg", contentType: "image/jpeg", data: photo }));
  report("sendDocument", await api.sendDocument({ chat_id: chatId, caption: "Synthetic smoke document" },
    { filename: "aiqsa-smoke.txt", contentType: "text/plain", data: Buffer.from("AIQSA Telegram smoke document.\n") }));

  // Voice fixture round trip: upload as a document, then getFile and download it back.
  const voice = readFileSync(path.join(FIXTURES, "voice.ogg"));
  const uploaded = report("sendDocument(voice.ogg)", await transport.upload({
    token, method: "sendDocument", fields: { chat_id: String(chatId), caption: "Synthetic smoke voice fixture" },
    file: { field: "document", filename: "voice.ogg", contentType: "audio/ogg", data: voice }
  }));
  const fileId = (uploaded as { document?: { file_id?: unknown }; audio?: { file_id?: unknown }; voice?: { file_id?: unknown } } | undefined);
  const id = [fileId?.document?.file_id, fileId?.audio?.file_id, fileId?.voice?.file_id].find((value): value is string => typeof value === "string");
  say(`voice_file_id_present=${Boolean(id)}`);
  if (id) {
    const file = report("getFile", await api.getFile(id));
    if (file?.file_path) {
      const bytes = report("downloadFile", await api.downloadFile(file.file_path));
      if (bytes) {
        const same = createHash("sha256").update(bytes).digest("hex") === createHash("sha256").update(voice).digest("hex");
        say(`voice_round_trip_bytes_match=${same}`);
        if (!same) failures.push("voice round trip");
      }
    }
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--capture-chat-id")) await captureChatId();
  else await smoke();
  if (failures.length) {
    say(`failed=${failures.length}`);
    process.exitCode = 1;
  } else if (!process.argv.includes("--capture-chat-id")) {
    say("all_ok=true");
  }
}

main().catch((error: unknown) => {
  say(`smoke_error=${error instanceof Error ? error.name : "unknown"}`);
  process.exitCode = 1;
});
