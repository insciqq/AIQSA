import { createHash, type Hash } from "node:crypto";
import type { ProviderHistoryItem, ProviderHistoryRenderOptions, ProviderNativeData } from "./history";

/**
 * The native engine's neutral history (`history.ts`) as Anthropic Messages
 * `messages`, and an Anthropic response as neutral history.
 *
 * Messages: user input, the run's own input (its attachments and response
 * reminder included) and tool results are `user` content; text, thinking and
 * tool calls are `assistant` content. Consecutive items of one role become
 * one message, so roles alternate and the user input after a turn that ended
 * on a tool result follows those results in the same message. No text block
 * is empty. Each assistant message's `tool_use` blocks are answered by its
 * `tool_result` blocks at the start of the next message and nowhere else; the
 * engine's selection guarantees it (`lib/server/engine/transcript.ts`) and a
 * history that breaks it is refused here before anything is sent. A request
 * that declares no tools carries earlier calls and results as text, since
 * Anthropic refuses tool blocks without tools.
 *
 * Thinking: `thinking` and `redacted_thinking` blocks replay whole, as the
 * API returned them, and only to the route and model that produced them (the
 * engine selects them, within the current turn). Anthropic binds a block to
 * everything sent before it (`system`, the set of `tools`, earlier content)
 * and to the block before it, and rejects a replayed block after any of them
 * changed on enforced accounts ("preserved thinking"; enforced for accounts
 * created from 2026-08-31). The engine's requests are not append-only (a
 * discovery adds tools, a compaction or a fitted result rewrites earlier
 * content, a reserved round's instruction rides on one request), so each
 * captured block records a digest of what preceded it and the identity of
 * the block before it, and rendering keeps only an unbroken run of blocks
 * whose record still holds: dropping thinking from the start, from the end or
 * entirely is valid, a gap is not. Manual thinking (`budget_tokens`) runs on
 * models that make no such check but need the latest assistant turn to start
 * with its thinking, so there blocks replay as stored.
 *
 * Prompt caching (`anthropicPromptCache`): a request that declares tools is a
 * round of a tool loop, so it marks its stable prefix and the ends of its two
 * latest user turns, and each round reads the rounds before it from the cache
 * instead of paying for them again. Cache markers are no part of the prefix a
 * thinking block is bound to, so the digest leaves them out.
 */

export type AnthropicHistoryMessage = { content: Record<string, unknown>[]; role: "assistant" | "user" };

/** What a request sends before its messages: the thinking check's prefix. */
export type AnthropicThinkingPrefix = Readonly<{ system: unknown; tools: readonly unknown[] }>;

export type AnthropicHistoryRenderOptions = ProviderHistoryRenderOptions<Record<string, unknown>[]> & Readonly<{
  /** The request's prefix to check replayed thinking against; null replays thinking as stored. */
  thinkingPrefix: AnthropicThinkingPrefix | null;
  /** The request declares tools; without them tool blocks render as text. */
  toolsDeclared: boolean;
}>;

/** What a captured block was produced after: the prefix digest and the block before it. */
type ThinkingBinding = Readonly<{ prefix: string; previous: string | null }>;

type Role = AnthropicHistoryMessage["role"];
type Part = Readonly<{ block: Record<string, unknown>; role: Role; thinking?: Readonly<{ binding: ThinkingBinding | null }> }>;
type Draft = { parts: Part[]; role: Role };

const FORMAT = "anthropic_messages";
/** Renamed when the digest changes, so older records fail the check instead of matching by accident. */
const DIGEST_SCHEME = "aiqsa-anthropic-thinking-2";
/** A prompt cache breakpoint with the default 5-minute lifetime, which every read renews. */
const CACHE_BREAKPOINT = Object.freeze({ type: "ephemeral" });
const PREVIEW_TOOL_OUTPUT = "[tool output omitted]";
/** Anthropic's tool id alphabet; another provider's call id is mapped into it. */
const TOOL_ID = /^[A-Za-z0-9_-]{1,128}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new Error("provider_history_item_invalid");
}

function nativeFields(data: ProviderNativeData | undefined): Readonly<Record<string, unknown>> {
  if (!data) return {};
  if (data.format !== FORMAT) throw new Error("provider_history_format_mismatch");
  return data.fields;
}

/** JSON with sorted keys: the digest ignores key order, as the API does. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function identity(block: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(canonical(block)).digest("base64url");
}

/** A `thinking` or `redacted_thinking` block. Not a type guard: a block that is neither stays a record. */
function isThinkingBlock(block: Readonly<Record<string, unknown>>): boolean {
  return block.type === "thinking" || block.type === "redacted_thinking";
}

/** A block the API can take back: signed thinking, or redacted thinking with its data. */
function replayable(block: Readonly<Record<string, unknown>>): boolean {
  return block.type === "thinking"
    ? typeof block.thinking === "string" && typeof block.signature === "string" && block.signature.length > 0
    : block.type === "redacted_thinking" && typeof block.data === "string" && block.data.length > 0;
}

/** A block, tool or system block without its cache marker, which moves between requests and binds nothing. */
function unmarked(value: unknown): unknown {
  if (!isRecord(value) || !("cache_control" in value)) return value;
  const { cache_control: _marker, ...rest } = value;
  return rest;
}

/** The running digest of a request's prefix, block by block with its role, thinking left out. */
class PrefixDigest {
  private readonly hash: Hash = createHash("sha256");

  constructor(prefix: AnthropicThinkingPrefix) {
    const name = (tool: unknown) => isRecord(tool) && typeof tool.name === "string" ? tool.name : "";
    // The API compares the tools as a set by name, so their order is not part of the prefix.
    const tools = [...prefix.tools].sort((left, right) => name(left) < name(right) ? -1 : name(left) > name(right) ? 1 : 0);
    this.feed(DIGEST_SCHEME, null);
    this.feed("system", Array.isArray(prefix.system) ? prefix.system.map(unmarked) : prefix.system ?? null);
    this.feed("tools", tools.map(unmarked));
  }

  feed(kind: string, value: unknown): void {
    this.hash.update(`${kind}\u0000${canonical(unmarked(value))}\u0000`);
  }

  snapshot(): string {
    return this.hash.copy().digest("base64url");
  }
}

function textBlock(text: string): Record<string, unknown> {
  return { text, type: "text" };
}

function toolId(callId: string): string {
  return TOOL_ID.test(callId) ? callId : `aiqsa_${createHash("sha256").update(callId).digest("base64url").slice(0, 32)}`;
}

function toolInput(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function binding(value: unknown): ThinkingBinding | null {
  return isRecord(value) && typeof value.prefix === "string" && (value.previous === null || typeof value.previous === "string")
    ? { prefix: value.prefix, previous: value.previous }
    : null;
}

function parts(item: ProviderHistoryItem, options: AnthropicHistoryRenderOptions): Part[] {
  switch (item.type) {
    case "user":
      return item.currentInput
        ? options.currentInput(item.text).map((block): Part => ({ block, role: "user" }))
        : [{ block: textBlock(item.text.trim() ? item.text : "[attachment]"), role: "user" }];
    case "assistant_text":
      nativeFields(item.native);
      return item.text.trim() ? [{ block: textBlock(item.text), role: "assistant" }] : [];
    case "reasoning": {
      const fields = nativeFields(item.native);
      const block = fields.block;
      if (!isRecord(block) || !isThinkingBlock(block) || !replayable(block)) invalid();
      return [{ block: options.preview ? { type: block.type } : { ...block }, role: "assistant",
        thinking: { binding: binding(fields.binding) } }];
    }
    case "tool_call":
      nativeFields(item.native);
      if (!options.toolsDeclared) {
        const text = `[Tool call ${item.name}]\n${options.preview ? "[arguments omitted]" : item.arguments}`;
        return [{ block: textBlock(text), role: "assistant" }];
      }
      return [{ block: options.preview ? { id: toolId(item.callId), name: item.name, type: "tool_use" }
        : { id: toolId(item.callId), input: toolInput(item.arguments), name: item.name, type: "tool_use" }, role: "assistant" }];
    case "tool_result": {
      const output = options.preview ? PREVIEW_TOOL_OUTPUT : item.output;
      if (!options.toolsDeclared) {
        return [{ block: textBlock(`[Tool result ${item.name}${item.isError ? ", error" : ""}]\n${output}`), role: "user" }];
      }
      return [{ block: { ...(output.trim() ? { content: output } : {}), ...(item.isError ? { is_error: true } : {}),
        tool_use_id: toolId(item.callId), type: "tool_result" }, role: "user" }];
    }
    case "compaction":
      nativeFields(item.native);
      return invalid();
  }
}

function merged(all: readonly Part[]): Draft[] {
  const messages: Draft[] = [];
  for (const part of all) {
    const last = messages.at(-1);
    if (last?.role === part.role) last.parts.push(part);
    else messages.push({ parts: [part], role: part.role });
  }
  return messages;
}

function ids(message: Draft | undefined, type: "tool_result" | "tool_use"): string[] {
  return (message?.parts ?? []).flatMap(({ block }) => block.type !== type ? []
    : [String(type === "tool_use" ? block.id : block.tool_use_id)]).sort();
}

/** Every call is answered at the start of the next message, by exactly its results. */
function assertToolPairing(messages: readonly Draft[]): void {
  messages.forEach((message, index) => {
    if (message.role === "assistant") {
      if (index === messages.length - 1 && ids(message, "tool_use").length > 0) invalid();
      return;
    }
    const results = ids(message, "tool_result");
    const leading = message.parts.findIndex(({ block }) => block.type !== "tool_result");
    if (leading >= 0 && leading < results.length) invalid();
    const calls = ids(index > 0 ? messages[index - 1] : undefined, "tool_use");
    if (results.length !== calls.length || results.some((id, position) => id !== calls[position])) invalid();
  });
}

/**
 * The replayed thinking whose record still holds: the latest block whose
 * prefix digest matches, then back while each kept block names the one
 * before it, in whole assistant messages. Everything else is dropped.
 */
function keepValidThinking(messages: readonly Draft[], prefix: AnthropicThinkingPrefix): Draft[] {
  if (!messages.some((message) => message.parts.some((part) => part.thinking))) return [...messages];
  const digest = new PrefixDigest(prefix);
  const seen: { identity: string; message: number; part: Part; prefix: string }[] = [];
  messages.forEach((message, index) => {
    for (const part of message.parts) {
      if (part.thinking) seen.push({ identity: identity(part.block), message: index, part, prefix: digest.snapshot() });
      else digest.feed(message.role, part.block);
    }
  });
  const holds = (entry: (typeof seen)[number]) => entry.part.thinking?.binding?.prefix === entry.prefix;
  let end = seen.length - 1;
  while (end >= 0 && !holds(seen[end]!)) end -= 1;
  const follows = (index: number) => seen[index]!.part.thinking?.binding?.previous === seen[index - 1]!.identity;
  let start = end;
  while (start > 0 && holds(seen[start - 1]!) && follows(start)) start -= 1;
  // A message keeps all of its thinking or none of it.
  while (start > 0 && start <= end && seen[start - 1]!.message === seen[start]!.message) start += 1;
  while (end >= 0 && end >= start && end + 1 < seen.length && seen[end + 1]!.message === seen[end]!.message) end -= 1;
  const kept = new Set(end >= 0 && start <= end ? seen.slice(start, end + 1).map((entry) => entry.part) : []);
  return merged(messages.flatMap((message) => message.parts).filter((part) => !part.thinking || kept.has(part)));
}

/** Anthropic `messages` for the history. */
export function anthropicMessagesFromHistory(
  history: readonly ProviderHistoryItem[],
  options: AnthropicHistoryRenderOptions
): AnthropicHistoryMessage[] {
  let messages = merged(history.flatMap((item) => parts(item, options)));
  assertToolPairing(messages);
  if (options.thinkingPrefix && !options.preview) messages = keepValidThinking(messages, options.thinkingPrefix);
  return messages.map((message) => ({ content: message.parts.map(({ block }) => block), role: message.role }));
}

/** The block with a cache breakpoint: the API caches the prompt up to and including it. */
function marked(block: Record<string, unknown>): Record<string, unknown> {
  return { ...block, cache_control: { ...CACHE_BREAKPOINT } };
}

/** A block that may carry a breakpoint: no thinking block and no empty text can. */
function cacheable(block: Readonly<Record<string, unknown>>): boolean {
  return !isThinkingBlock(block) && (block.type !== "text" || (typeof block.text === "string" && block.text.trim().length > 0));
}

/** The message with a breakpoint on its last block that may carry one; unchanged when none may. */
function markedAtEnd(message: AnthropicHistoryMessage): AnthropicHistoryMessage {
  for (let index = message.content.length - 1; index >= 0; index -= 1) {
    if (cacheable(message.content[index]!)) {
      return { ...message, content: message.content.map((block, position) => position === index ? marked(block) : block) };
    }
  }
  return message;
}

/**
 * Prompt cache breakpoints for one round of a tool loop, at most four, the
 * API's limit: the last tool (a chat's tools stay the same across its turns),
 * the system prompt (the same for every request of a run), the end of the
 * user turn before the latest assistant turn (where the previous request put
 * its last breakpoint, so its cache is read even when one assistant turn adds
 * more blocks than the API looks back over) and the end of the latest
 * message (written for the next round). A request without tools does not
 * cache: it is a single call (a compaction summary) whose write is never read.
 */
export function anthropicPromptCache(input: Readonly<{
  messages: readonly AnthropicHistoryMessage[];
  system: readonly Record<string, unknown>[] | undefined;
  tools: readonly Record<string, unknown>[];
}>): Readonly<{ messages: AnthropicHistoryMessage[]; system: Record<string, unknown>[] | undefined; tools: Record<string, unknown>[] }> {
  if (input.tools.length === 0) return { messages: [...input.messages], system: input.system && [...input.system], tools: [] };
  const messages = [...input.messages];
  const latest = messages.length - 1;
  let assistant = latest - 1;
  while (assistant >= 0 && messages[assistant]!.role !== "assistant") assistant -= 1;
  for (const index of [latest, assistant - 1]) {
    if (index >= 0 && index <= latest) messages[index] = markedAtEnd(messages[index]!);
  }
  const system = input.system === undefined ? undefined
    : input.system.map((block, index) => index === input.system!.length - 1 ? marked(block) : block);
  return { messages, system, tools: input.tools.map((tool, index) => index === input.tools.length - 1 ? marked(tool) : tool) };
}

/**
 * One response's content as history, in content order: replayable thinking
 * blocks whole with what they were produced after, non-empty text, and tool
 * calls with their ids. Hosted Search blocks stay out, as on other routes.
 * `sent` is the request body the response answered.
 */
export function anthropicHistoryFromContent(
  content: readonly unknown[],
  sent: Readonly<{ messages?: unknown; system?: unknown; tools?: unknown }>
): ProviderHistoryItem[] {
  const items: ProviderHistoryItem[] = [];
  let digest: PrefixDigest | null = null;
  let previous: string | null = null;
  if (content.some((block) => isRecord(block) && isThinkingBlock(block))) {
    digest = new PrefixDigest({ system: sent.system, tools: Array.isArray(sent.tools) ? sent.tools : [] });
    for (const message of Array.isArray(sent.messages) ? sent.messages : []) {
      if (!isRecord(message) || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (!isRecord(block)) continue;
        if (isThinkingBlock(block)) previous = identity(block);
        else digest.feed(String(message.role), block);
      }
    }
  }
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (isThinkingBlock(block)) {
      if (!replayable(block)) continue;
      const fields = { binding: { prefix: digest!.snapshot(), previous }, block: { ...block } };
      items.push({ native: { fields, format: FORMAT }, type: "reasoning" });
      previous = identity(block);
      continue;
    }
    const item: ProviderHistoryItem | null = block.type === "text" && typeof block.text === "string" && block.text.trim()
      ? { text: block.text, type: "assistant_text" }
      : block.type === "tool_use" && typeof block.id === "string" && block.id && typeof block.name === "string" && block.name
        ? { arguments: JSON.stringify(isRecord(block.input) ? block.input : {}), callId: block.id, name: block.name, type: "tool_call" }
        : null;
    if (!item) continue;
    items.push(item);
    // The block as a later request replays it.
    for (const part of parts(item, { currentInput: () => [], preview: false, thinkingPrefix: null, toolsDeclared: true })) {
      digest?.feed("assistant", part.block);
    }
  }
  return items;
}
