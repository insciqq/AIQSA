/**
 * OpenAI's hosted web search tags every link it cites with
 * `utm_source=openai`, in the answer's text and in its citations; users copy
 * and forward those links (operator decision 2026-11-20: drop it). Only that
 * exact parameter goes: every other parameter, `utm_*` included, and the
 * fragment stay as written. Pure and shared by server and browser.
 */

const ATTRIBUTION = "utm_source=openai";
const QUICK_CHECK = /utm_source=openai/u;
/** A link in prose: it stops at whitespace, quotes and angle brackets, so a Markdown target keeps its closing parenthesis. */
const TEXT_LINK = /https?:\/\/[^\s<>"'`]+/giu;
/**
 * The parameter inside one link of text, with what ends it: another parameter, the fragment, the end of the link, or what
 * closes a Markdown target or ends a sentence. Punctuation and emphasis marks count as an end only when nothing of the link
 * follows them, so a value such as `openai.com` or `openai_blog` is another value and stays.
 */
const IN_LINK = /([?&])utm_source=openai(&|(?=[#)\]}>]|[.,;:!?*_~]+(?:$|[)\]}>])|$))/gu;

/** The link without the exact `utm_source=openai` parameter; a `?` or `&` left with nothing to join goes too. */
export function withoutOpenAiAttribution(url: string): string {
  if (!QUICK_CHECK.test(url)) return url;
  const hashAt = url.indexOf("#");
  const beforeHash = hashAt < 0 ? url : url.slice(0, hashAt);
  const fragment = hashAt < 0 ? "" : url.slice(hashAt);
  const queryAt = beforeHash.indexOf("?");
  if (queryAt < 0) return url;
  const kept = beforeHash.slice(queryAt + 1).split("&").filter((part) => part !== ATTRIBUTION);
  const query = kept.join("&");
  return `${beforeHash.slice(0, queryAt)}${query ? `?${query}` : ""}${fragment}`;
}

function cleanLink(link: string): string {
  return link.replace(IN_LINK, (_match, lead: string, joiner: string) => lead === "?" ? joiner ? "?" : "" : joiner);
}

/** Where a link at the end of streaming text may still become the parameter, so the text shown only ever grows. */
function heldFrom(text: string): number {
  const linkStart = text.search(/https?:\/\/[^\s<>"'`]*$/u);
  if (linkStart < 0) return text.length;
  for (let index = Math.max(linkStart, text.length - ATTRIBUTION.length - 8); index < text.length; index += 1) {
    const char = text[index];
    if (char !== "?" && char !== "&") continue;
    const rest = text.slice(index + 1);
    // A prefix of the parameter, or the whole of it followed only by what may still end it.
    if (ATTRIBUTION.startsWith(rest) || /^utm_source=openai[.,;:!?]*$/u.test(rest)) return index;
  }
  return text.length;
}

/**
 * Text with the parameter removed from every http(s) link, Markdown targets and bare links alike. With `partial`, the text
 * is still streaming: a link's tail that may still become the parameter is held back.
 */
export function withoutOpenAiAttributionInText(text: string, options: Readonly<{ partial?: boolean }> = {}): string {
  const held = options.partial ? heldFrom(text) : text.length;
  const shown = held < text.length ? text.slice(0, held) : text;
  return QUICK_CHECK.test(shown) ? shown.replace(TEXT_LINK, cleanLink) : shown;
}
