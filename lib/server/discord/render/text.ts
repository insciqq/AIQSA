import type { ThreadCitation } from "@/lib/contracts/chats";
import { safeExternalHref } from "@/lib/domain/links";
import { containsOutgoingSecret } from "../redaction";

/**
 * Text-level rules of the Discord sink. Model text reaches Discord only as
 * escaped text: no mention (`<@…>`, `<@&…>`, `<#…>`, `@everyone`, `@here`),
 * timestamp (`<t:…>`), guild navigation (`<id:…>`), slash-command or emoji
 * markup survives, because every `<` the model writes gets a zero-width
 * space after it and `@everyone`/`@here` get one after the `@`. The only
 * links are `http(s)` addresses this module checked, written as `<url>` or as
 * a citation's `[N](<url>)`; angle brackets keep Discord from previewing them.
 */

export const ZERO_WIDTH_SPACE = "\u200b";
const MAX_HREF_LENGTH = 512;

/** Breaks the mention forms; enough on its own inside code, where Discord renders no other markup. */
export function neutralizeMentions(value: string): string {
  return value
    .replace(/<(?=[@#])/gu, `<${ZERO_WIDTH_SPACE}`)
    .replace(/@(?=everyone|here)/giu, `@${ZERO_WIDTH_SPACE}`);
}

/** Model text as literal Discord text: Markdown punctuation escaped, every `<` and non-web `://` broken. */
export function escapeDiscordText(value: string): string {
  return neutralizeMentions(value
    .replace(/[\\*_~`|[\]]/gu, "\\$&")
    // Also at the end: the next node may start with what completes the markup.
    .replace(/<(?!\s)/gu, `<${ZERO_WIDTH_SPACE}`)
    .replace(/:\/\//gu, `:${ZERO_WIDTH_SPACE}//`));
}

/**
 * Escapes what Discord reads as block syntax at a line start: headings,
 * subtext (`-#`), quotes and list markers. Only the renderer's own markup may
 * start a line with them.
 */
export function guardLineStarts(value: string): string {
  return value.split("\n").map(line => line
    .replace(/^([ \t]*)([#>+-])/u, "$1\\$2")
    .replace(/^([ \t]*\d{1,9})([.)])(?=[ \t]|$)/u, "$1\\$2")).join("\n");
}

/** An `http(s)` address safe to write inside `<…>`: no credentials, no secret, `@` encoded, bounded. */
export function safeDiscordHref(value: unknown): string | null {
  const checked = safeExternalHref(value);
  if (!checked || !/^https?:/iu.test(checked)) return null;
  let url: URL;
  try {
    url = new URL(checked);
  } catch {
    return null;
  }
  if (url.username || url.password || (url.protocol !== "http:" && url.protocol !== "https:")) return null;
  // The serializer percent-encodes `<`, `>`, quotes and spaces; `@` can now only follow the host, and
  // brackets, parentheses, pipes and backticks are encoded so no address can read as Markdown around it.
  const href = url.href.replace(/[@[\]()|`]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  if (href.length > MAX_HREF_LENGTH || containsOutgoingSecret(href)) return null;
  return href;
}

/** `[N]` index → checked address; only server-provided citation metadata enters it. */
export function citationHrefs(citations: readonly ThreadCitation[] = []): ReadonlyMap<string, string> {
  const hrefs = new Map<string, string>();
  for (const citation of citations) {
    const href = safeDiscordHref(citation.url);
    if (href && Number.isSafeInteger(citation.index) && citation.index > 0) hrefs.set(String(citation.index), href);
  }
  return hrefs;
}

const HTML_TAG = /<\/?[A-Za-z][A-Za-z0-9-]{0,31}(?:[ \t/][^<>\n]{0,512})?>/gu;
const FOOTNOTE_REFERENCE = /\[\^[^\]\s]{1,64}\]/gu;
export const FOOTNOTE_DEFINITION = /^\[\^[^\]\s]{1,64}\]:/u;

/** Drops raw HTML tags, closed HTML comments and footnote references from model text. */
export function dropMarkup(value: string): string {
  let text = "";
  let cursor = 0;
  for (;;) {
    const start = value.indexOf("<!--", cursor);
    if (start < 0) break;
    const end = value.indexOf("-->", start + 4);
    if (end < 0) break;
    text += value.slice(cursor, start);
    cursor = end + 3;
  }
  text += value.slice(cursor);
  return text.replace(HTML_TAG, "").replace(FOOTNOTE_REFERENCE, "");
}

const LINKABLE = /\[([1-9]\d{0,3})\]|https?:\/\/[^\s<>[\]]+/giu;

function trimUrl(raw: string): string {
  let url = raw.replace(/[.,;:!?'"*_~]+$/u, "");
  while (url.endsWith(")") && (url.match(/\(/gu)?.length ?? 0) < (url.match(/\)/gu)?.length ?? 0)) {
    url = url.slice(0, -1).replace(/[.,;:!?'"*_~]+$/u, "");
  }
  return url;
}

/**
 * Text outside a link: a `[N]` with a checked citation address becomes
 * `[N](<url>)`, a bare checked `http(s)` address becomes `<url>`, and the
 * rest is escaped. No Sources list is ever added (RUN_CONTRACTS).
 */
export function linkedText(value: string, citations: ReadonlyMap<string, string>): string {
  let out = "";
  let cursor = 0;
  for (const match of value.matchAll(LINKABLE)) {
    const index = match.index;
    if (index < cursor) continue;
    if (match[1] !== undefined) {
      const href = citations.get(match[1]);
      if (!href) continue;
      out += escapeDiscordText(value.slice(cursor, index)) + `[${match[1]}](<${href}>)`;
      cursor = index + match[0].length;
      continue;
    }
    const raw = trimUrl(match[0]);
    const href = safeDiscordHref(raw);
    if (!href) continue;
    out += escapeDiscordText(value.slice(cursor, index)) + `<${href}>`;
    cursor = index + raw.length;
  }
  return out + escapeDiscordText(value.slice(cursor));
}

/** Inline code: mentions broken, no line breaks, backtick runs that could end it broken. */
export function inlineCode(value: string): string {
  const code = neutralizeMentions(value.replace(/[\r\n]+/gu, " ")).replace(/`(?=`)/gu, `\`${ZERO_WIDTH_SPACE}`);
  if (!code.trim()) return "";
  return code.includes("`") ? `\`\` ${code} \`\`` : `\`${code}\``;
}

const CODE_LANGUAGE = /^[a-z0-9][a-z0-9_+.#-]{0,31}$/iu;

/** A fenced block whose content cannot close it early. */
export function codeBlock(code: string, language = ""): string {
  const body = neutralizeMentions(code.replace(/\n+$/u, "")).replace(/`(?=``)/gu, `\`${ZERO_WIDTH_SPACE}`);
  return `\`\`\`${CODE_LANGUAGE.test(language) ? language : ""}\n${body}\n\`\`\``;
}
