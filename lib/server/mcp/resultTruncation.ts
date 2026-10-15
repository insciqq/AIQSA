/** Content-free facts of a tools/call result cut to its byte limit. Both sizes
 * are the UTF-8 bytes of the result's JSON snapshot, the measurement the
 * client's result limit uses. */
export type McpResultTruncation = Readonly<{ deliveredBytes: number; originalBytes: number }>;

type ContentPart = Readonly<{ type: string; text?: string }>;
/** A validated tools/call result value, as the client normalizes it. */
export type McpCallResultValue = Readonly<{
  content: readonly ContentPart[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}>;

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const EMPTY_TEXT_PART_BYTES = jsonBytes({ type: "text", text: "" });
const STRUCTURED_KEY_BYTES = Buffer.byteLength(',"structuredContent":', "utf8");

/** Persisted `rawPreview` metadata of a truncated result: sizes only, never content. */
export function mcpTruncationPreview(truncation: McpResultTruncation) {
  return { truncated: true as const, originalBytes: truncation.originalBytes, deliveredBytes: truncation.deliveredBytes };
}

/** Telemetry fields of a truncated result. */
export function mcpTruncationTelemetry(truncation: McpResultTruncation | undefined) {
  return truncation
    ? { truncated: true, original_bytes: truncation.originalBytes, delivered_bytes: truncation.deliveredBytes }
    : {};
}

/** Stable English, ASCII only without JSON escapes, so its byte size is its length. */
export function mcpTruncationMarker(input: Readonly<{ deliveredBytes: number; maxBytes: number; originalBytes: number }>): string {
  return `[Result truncated: the MCP tool returned ${input.originalBytes} bytes, more than the ${input.maxBytes}-byte result limit. ` +
    `Only the first ${input.deliveredBytes} bytes were delivered; the rest of the result was not delivered. ` +
    "Repeating the same call returns the same truncated result.]";
}

/** Bytes JSON.stringify spends on one UTF-16 code unit (or pair) of a string. */
function escapedWidth(text: string, index: number): Readonly<{ bytes: number; units: 1 | 2 }> {
  const code = text.charCodeAt(index);
  if (code === 0x22 || code === 0x5c) return { bytes: 2, units: 1 };
  if (code < 0x20) return { bytes: code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6, units: 1 };
  if (code < 0x80) return { bytes: 1, units: 1 };
  if (code < 0x800) return { bytes: 2, units: 1 };
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = text.charCodeAt(index + 1);
    if (next >= 0xdc00 && next <= 0xdfff) return { bytes: 4, units: 2 };
  }
  // JSON.stringify escapes an isolated surrogate as \uXXXX.
  if (code >= 0xd800 && code <= 0xdfff) return { bytes: 6, units: 1 };
  return { bytes: 3, units: 1 };
}

/** The longest prefix whose JSON string body (without quotes) fits; it never
 * ends inside a multi-byte character or a surrogate pair. */
export function jsonStringPrefix(text: string, maxBytes: number): string {
  let used = 0;
  let index = 0;
  while (index < text.length) {
    const width = escapedWidth(text, index);
    if (used + width.bytes > maxBytes) break;
    used += width.bytes;
    index += width.units;
  }
  return text.slice(0, index);
}

function digits(value: number): number {
  return String(value).length;
}

/**
 * Cuts a fully received, validated tools/call result to `maxBytes` of its JSON
 * snapshot. Text parts keep their order and the first one that does not fit is
 * cut on a character boundary; later text is the undelivered tail. Structured
 * content and non-text parts stay only while they fit after the text. One
 * marker text part closes the content; `isError` is unchanged. Returns null
 * when the limit cannot hold even the marker.
 */
export function truncateMcpCallResult(result: McpCallResultValue, originalBytes: number, maxBytes: number):
  Readonly<{ truncation: McpResultTruncation; value: McpCallResultValue }> | null {
  const envelope = (content: readonly ContentPart[], structuredContent?: Record<string, unknown>): McpCallResultValue => ({
    content,
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
    ...(structuredContent ? { structuredContent } : {})
  });
  const marker = (deliveredBytes: number) => ({ type: "text", text: mcpTruncationMarker({ deliveredBytes, maxBytes, originalBytes }) });
  // The delivered size never exceeds the limit, so the limit's digit count is
  // the widest number the marker can show.
  let remaining = maxBytes - jsonBytes(envelope([marker(maxBytes)]));
  if (remaining < 0) return null;

  const kept = new Map<number, ContentPart>();
  let textCut = false;
  for (const [index, part] of result.content.entries()) {
    if (part.type !== "text" || typeof part.text !== "string") continue;
    if (textCut) break;
    // Every kept part adds one comma before the marker.
    const bytes = jsonBytes(part) + 1;
    if (bytes <= remaining) {
      kept.set(index, part);
      remaining -= bytes;
      continue;
    }
    textCut = true;
    const prefix = jsonStringPrefix(part.text, remaining - EMPTY_TEXT_PART_BYTES - 1);
    if (!prefix) break;
    kept.set(index, { type: "text", text: prefix });
    remaining -= EMPTY_TEXT_PART_BYTES + 1 + Buffer.byteLength(JSON.stringify(prefix), "utf8") - 2;
  }
  let structuredContent: Record<string, unknown> | undefined;
  if (result.structuredContent !== undefined) {
    const bytes = STRUCTURED_KEY_BYTES + jsonBytes(result.structuredContent);
    if (bytes <= remaining) {
      structuredContent = result.structuredContent;
      remaining -= bytes;
    }
  }
  for (const [index, part] of result.content.entries()) {
    if (part.type === "text" && typeof part.text === "string") continue;
    const bytes = jsonBytes(part) + 1;
    if (bytes <= remaining) {
      kept.set(index, part);
      remaining -= bytes;
    }
  }

  const content = [...kept.entries()].sort(([left], [right]) => left - right).map(([, part]) => part);
  // The marker is plain ASCII, so the result's size moves only with the
  // digits of the count it reports: settle that count exactly.
  const withoutCount = jsonBytes(envelope([...content, marker(0)], structuredContent)) - 1;
  let deliveredBytes = withoutCount + digits(maxBytes);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = withoutCount + digits(deliveredBytes);
    if (next === deliveredBytes) break;
    deliveredBytes = next;
  }
  const value = envelope([...content, marker(deliveredBytes)], structuredContent);
  if (deliveredBytes > maxBytes || jsonBytes(value) !== deliveredBytes) return null;
  return { truncation: { deliveredBytes, originalBytes }, value };
}
